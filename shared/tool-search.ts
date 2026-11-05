/**
 * The name of the tool a Bot calls to find the tools it holds but has not been shown.
 *
 * Shared because two places must agree on it: the server, which offers the tool and reads its
 * answers back (`server/src/agents/tool-search.ts`), and the conversation, which draws a call to it
 * in words rather than as the identifier (`OWN_TOOLS` in `tool-name.ts`).
 */
export const SEARCH_TOOLS = "search_tools";
