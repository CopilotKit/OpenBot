/**
 * Where an old `/agents` link goes now that the roster and each Bot's page replaced it.
 *
 * Old links are not only bookmarks: the model was told a new Bot's profile is at
 * `/agents?agent=<id>`, and that sentence is in conversations people still scroll back through.
 */
export function legacyAgentsTarget(search: { new?: boolean; agent?: string }) {
  if (search.new === true) {
    return { to: "/bots", search: { new: true }, replace: true } as const;
  }
  if (search.agent) {
    return {
      to: "/bots/$agentId",
      params: { agentId: search.agent },
      replace: true,
    } as const;
  }
  return { to: "/bots", replace: true } as const;
}

/**
 * Whether an `/agents` address is an old link to a Bot or to New Bot. `/agents` on its own is the
 * Agents page now, the list of agents Bots hand work to; only the two old search parameters still
 * lead to the Bots.
 */
export function isLegacyAgentsLink(search: {
  new?: boolean;
  agent?: string;
}): boolean {
  return search.new === true || Boolean(search.agent);
}

/**
 * The pages that left the sidebar, and where their contents went. What was about one Bot is on that
 * Bot's page; what was the person's own is in Settings, or on Routines.
 */
export const LEGACY_PAGES = {
  "/approvals": "/settings/approvals",
  "/reachability": "/settings/notifications",
  "/responsibilities": "/routines",
  // A group is started from the new-conversation screen by putting two or more Bots in To:.
  "/group/new": "/channel/new",
} as const;
