/**
 * Public-web research by role rather than by provider, shared by the server and the app.
 *
 * A skill declares `@research/search` and `@research/fetch` instead of one provider's tool names,
 * and the server matches each to that role's tool on every research connector. So a research skill
 * keeps working when a deployment switches provider, and the transcript can say "Search the web"
 * instead of naming whichever vendor answered.
 */
export type ResearchRole = "search" | "fetch";

/**
 * One provider's public-web research tools.
 *
 * `search` finds sources for a query and `fetch` reads pages by URL. Both are required, because a
 * Bot that can find a page and cannot read it has links and no evidence.
 */
export type ResearchTools = {
  search: string;
  fetch: string;
  /** How this provider's own parameters are best used, added to the shared guidance verbatim. */
  notes?: readonly string[];
};

const PARALLEL: ResearchTools = Object.freeze({
  search: "web_search",
  fetch: "web_fetch",
  notes: Object.freeze([
    "Generate one session_id for the conversation and reuse it on related search and fetch calls.",
    "Omit model_name unless the exact configured model identifier is known.",
  ]),
});

const EXA: ResearchTools = Object.freeze({
  search: "web_search_exa",
  fetch: "web_fetch_exa",
});

const FIRECRAWL: ResearchTools = Object.freeze({
  search: "firecrawl_search",
  fetch: "firecrawl_scrape",
});

/**
 * The research tools on each catalogue entry, by the entry's key.
 *
 * Here rather than on the entries in `server/src/plugins/catalogue.ts` because the app labels these
 * tools too, and it cannot import the server. A key here that is not a catalogue entry is a test
 * failure, so the two lists cannot drift.
 */
export const RESEARCH_TOOLS: Readonly<Record<string, ResearchTools>> =
  Object.freeze({
    parallel: PARALLEL,
    "parallel-authenticated": PARALLEL,
    exa: EXA,
    "exa-authenticated": EXA,
    firecrawl: FIRECRAWL,
    "firecrawl-authenticated": FIRECRAWL,
  });

/** What a research call is called on screen, whichever provider made it. */
export const RESEARCH_ROLE_LABELS: Readonly<Record<ResearchRole, string>> =
  Object.freeze({ search: "Search the web", fetch: "Read web pages" });

/** The research role a tool on this server plays, or null when it plays none. */
export function researchRoleOfTool(
  server: string,
  tool: string,
): ResearchRole | null {
  const research = Object.hasOwn(RESEARCH_TOOLS, server)
    ? RESEARCH_TOOLS[server]
    : undefined;
  if (research?.search === tool) return "search";
  if (research?.fetch === tool) return "fetch";
  return null;
}

/**
 * Shaped like a `serverId/toolName` ref so a declaration passes the same check as any other, and
 * starting with a character no server id may contain, so it can never be mistaken for one.
 */
export const RESEARCH_ROLE_PREFIX = "@research";

export const RESEARCH_ROLES: readonly { ref: string; label: string }[] = [
  { ref: `${RESEARCH_ROLE_PREFIX}/search`, label: RESEARCH_ROLE_LABELS.search },
  { ref: `${RESEARCH_ROLE_PREFIX}/fetch`, label: RESEARCH_ROLE_LABELS.fetch },
];

/** The research role a skill's tool ref names, or null when it names a server's own tool. */
export function researchRoleOf(ref: string): ResearchRole | null {
  const [prefix, role, extra] = ref.split("/");
  if (prefix !== RESEARCH_ROLE_PREFIX || extra !== undefined) return null;
  return role === "search" || role === "fetch" ? role : null;
}

/**
 * The research role a tool plays, from the name a model is offered it under, or null.
 *
 * Granted tools reach a model as `mcp__<server>__<tool>`. A Bot running its own loop (`agent-bot`,
 * `agent-langgraph`) sees only those names, not the refs the server holds, so this is how it learns
 * whether it was offered a search tool on this run.
 */
export function researchRoleOfToolName(name: string): ResearchRole | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return null;
  return researchRoleOfTool(
    rest.slice(0, separator),
    rest.slice(separator + 2),
  );
}

/**
 * The search apps a Bot holding none may offer the person, by a name the app card resolves.
 *
 * Titles of the free catalogue entries, because `show_app_access` resolves an app's key or title and
 * nothing more general: there is no app called "search". All of them rather than one, because which
 * search app a deployment uses is the administrator's choice. A name here that is not a research
 * entry's title is a test failure, so the list cannot drift from the catalogue.
 */
export const RESEARCH_APP_NAMES: readonly string[] = Object.freeze([
  "Parallel Search",
  "Exa Search",
  "Firecrawl",
]);
