-- A Mastra Bot is a stored kind, not only a code path.
--
-- `remote_mastra` was added to the types and to the runtime without this, so a Mastra Bot compiled,
-- passed its tests, and could not be written: the enum rejected the row. Added on its own rather
-- than folded into a later migration, because the code that reads it already shipped.
ALTER TYPE "public"."agent_type" ADD VALUE 'remote_mastra';
