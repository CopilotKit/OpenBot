/**
 * Public-web research by role rather than by provider, shared by the server and the app.
 *
 * A skill declares `@research/search` and `@research/fetch` instead of one provider's tool names,
 * and the server matches each to that role's tool on every research connector in its catalogue. So
 * a research skill keeps working when a deployment switches provider.
 */
export type ResearchRole = "search" | "fetch";

/**
 * Shaped like a `serverId/toolName` ref so a declaration passes the same check as any other, and
 * starting with a character no server id may contain, so it can never be mistaken for one.
 */
export const RESEARCH_ROLE_PREFIX = "@research";

export const RESEARCH_ROLES: readonly { ref: string; label: string }[] = [
  { ref: `${RESEARCH_ROLE_PREFIX}/search`, label: "Search the web" },
  { ref: `${RESEARCH_ROLE_PREFIX}/fetch`, label: "Read pages" },
];

/** The research role a skill's tool ref names, or null when it names a server's own tool. */
export function researchRoleOf(ref: string): ResearchRole | null {
  const [prefix, role, extra] = ref.split("/");
  if (prefix !== RESEARCH_ROLE_PREFIX || extra !== undefined) return null;
  return role === "search" || role === "fetch" ? role : null;
}
