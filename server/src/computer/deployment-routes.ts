/**
 * The paths under the computer router that are about the deployment rather than about a Bot.
 *
 * Its own file because two places have to agree on it and they sit at opposite ends of the system.
 * The router steps aside for these names, and the tenant package refuses to give a Bot one. Kept in
 * one list so that adding a third deployment route reserves the name at the same moment it starts
 * being answered, rather than opening the hole again and waiting for somebody to notice.
 *
 * The reason there is anything to agree on: the bot-access middleware matches `/:botId/*`, and
 * Hono's `/*` matches zero segments, so a single-segment path like `/policy` arrives as a Bot id.
 * Nothing in the request distinguishes the two, so a Bot that really is called `policy` would be
 * indistinguishable from the deployment route and would be served without the guard being asked.
 */
export const DEPLOYMENT_ROUTES = new Set(["policy", "fleet", "policy-dry-run"]);
