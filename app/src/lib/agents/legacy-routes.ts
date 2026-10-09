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
