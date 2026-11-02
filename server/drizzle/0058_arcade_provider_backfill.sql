-- The data half of `0057_arcade_provider`, which is the schema half and runs first. Two rules no
-- generator can write, because neither is in the schema.

-- 1. EVERY BROKERED APP THAT HAS AN ACCOUNT SAYS WHOSE.
--
-- `addBrokeredApp` settles `account_mode` on its INSERT and, from this release on, after its upsert
-- as well. Its CONFLICT arm never did, so an enable that landed on a row that was not brokered (one
-- added by hand, restored, or left by a build that spelled ids differently) converted it to a
-- brokered app and left this column null. `accountFor` refuses a call against such a row as
-- ambiguous, so the app is enabled, listed, connectable and dead.
--
-- THIS RUNS BECAUSE THE CODE FIX CANNOT REACH THOSE ROWS. An enabled app cannot be added again
-- without being removed first, and removing it deletes every connection on it, so "press Add again"
-- is not a remedy an administrator can perform.
--
-- `personal` is what the insert writes for a new app and the conservative answer: each person
-- reaches their own account. `shared` would hand everybody one account nobody chose to share.
--
-- ONLY ROWS WITH AN ACCOUNT TO HOLD. `NO_AUTH` is the one scheme with none. A null `auth_scheme` is
-- NOT in that set: `schemeKind` calls it `unreadable`, which `accountFor` treats as having an
-- account, so it needs the mode just as much as a recorded `OAUTH2` row.
--
-- ONLY ROWS THAT SAY NOTHING. A deployment that chose Shared keeps it.
UPDATE "mcp_servers"
   SET "account_mode" = 'personal'
 WHERE "provenance" IN ('composio', 'arcade')
   AND "account_mode" IS NULL
   AND ("auth_scheme" IS NULL OR "auth_scheme" <> 'NO_AUTH');--> statement-breakpoint

-- 2. EVERY RECORDED ACTION GETS THE VENDOR'S SPELLING OF ITS NAME, WHICH IS ITS NAME.
--
-- `mcp_tools.vendor_name` is new in 0057 and is the name an action is executed by; `name` is this
-- deployment's identifier and what a model is offered. They differ only for Arcade (`Gmail.ListEmails`
-- against `ListEmails`). Every row that exists when this runs was listed by Composio, an MCP server
-- or the Drive REST transport, whose names are already offerable, so for them the two spellings are
-- genuinely the same string. That is the value, not a placeholder.
--
-- THE COLUMN STAYS NULLABLE, AND NULL STILL MEANS "SAME AS `name`". A rolling deploy runs this and
-- then serves from old and new replicas at once; an old replica refreshing a listing inserts rows
-- without the column, after this UPDATE has finished. Every reader therefore resolves it through
-- `vendorNameOf` (`coalesce(vendor_name, name)`), and `NOT NULL` belongs to a later release, once
-- the fleet has turned over and a second pass of this same UPDATE has run.
UPDATE "mcp_tools"
   SET "vendor_name" = "name"
 WHERE "vendor_name" IS NULL;
