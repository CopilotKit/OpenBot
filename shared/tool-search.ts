/**
 * The name of the tool a Bot calls to find the tools it holds but has not been shown.
 *
 * Shared because two places must agree on it: the server, which offers the tool and reads its
 * answers back (`server/src/agents/tool-search.ts`), and the conversation, which draws a call to it
 * in words rather than as the identifier (`OWN_TOOLS` in `tool-name.ts`).
 */
export const SEARCH_TOOLS = "search_tools";

/**
 * The first line of every answer the search gives, naming the tools it found, and the only line
 * anything reads names from: the server, to send those tools next, and the conversation, to say
 * which tools were found in words. The lines under it are an app's own descriptions, which must
 * not name a tool into either.
 */
export const TOOLS_FOUND_LINE = "Tools found:";

/** The tool names on a search answer's {@link TOOLS_FOUND_LINE}, and nothing from below it. */
export function toolsFound(answer: string): string[] {
  const first = answer.split("\n", 1)[0] ?? "";
  if (!first.startsWith(TOOLS_FOUND_LINE)) return [];
  return first
    .slice(TOOLS_FOUND_LINE.length)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}
