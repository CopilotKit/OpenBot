# Public-web research

OpenBot ships three public-web research providers in the plugin catalogue: **Parallel**, **Exa** and **Firecrawl**. Each one gives a Bot a search tool, which finds sources for a query, and a fetch tool, which reads pages by URL. A Bot holding both tools from one provider is told how to research with them. None of this uses the Bot's browser, and no existing Bot gets new access automatically.

| Catalogue entry           | Search tool        | Fetch tool         | Credential                                           |
| ------------------------- | ------------------ | ------------------ | ---------------------------------------------------- |
| Parallel Search           | `web_search`       | `web_fetch`        | None; provider-managed limits for light use          |
| Parallel Search (API key) | `web_search`       | `web_fetch`        | Deployment API key, sent as a Bearer token           |
| Exa Search                | `web_search_exa`   | `web_fetch_exa`    | None; free, rate-limited                             |
| Exa Search (API key)      | `web_search_exa`   | `web_fetch_exa`    | Deployment API key, sent in Exa's `x-api-key` header |
| Firecrawl                 | `firecrawl_search` | `firecrawl_scrape` | None; free access offers search, scrape and parse    |
| Firecrawl (API key)       | `firecrawl_search` | `firecrawl_scrape` | Deployment API key, sent as a Bearer token           |

## Enable research

1. As an administrator, open Plugins and add a provider from the catalogue. For the keyed entries, enter the provider's API key; it is stored in the server-side credential vault.
2. Grant that provider's search and fetch tools to the Bots that should research the public web. For the shipped fintech package, select **Research Desk**.
3. Ask the Bot to research a topic. It searches, reads selected sources and cites their URLs. Run `/research-public-web` to select the example skill explicitly if your deployment has many tools.

For production or higher limits, use a keyed entry and remove the grants on the free one. If a Bot holds a vendor's free and keyed entries, it is told about the keyed one.

## Skills declare roles, not providers

A skill names the research tools it needs as `@research/search` and `@research/fetch`, instead of one provider's tool names. Each role matches that role's tool on every research provider in the catalogue, intersected as always with what the Bot was granted. The shipped `research-public-web` skill does this, so it works with whichever provider a deployment connects. A role declaration grants nothing.

## Choice and controls

In a conversation, research calls are labelled for what they did, "Search the web" and "Read web pages", whichever provider made them, and the Bot does not name the provider unless asked. Which provider a Bot holds is shown on its access page.

A Bot holding more than one provider is told about each and uses the one the person asks for. Administrators can revoke tools, remove a connector or grant another provider. Every call goes through `PluginStore.callTool`, with the usual grants, action policies and audit records; no raw MCP server is added to the agent configuration.

Exa and Firecrawl name the tools that only read (`readTools` in the catalogue), and every other tool they advertise counts as a write. Firecrawl publishes tool families such as `firecrawl_monitor_*`, and Exa's agent tools spend credits, so neither can be safely described by a list of writes alone.

The provider receives model-selected objectives, search queries, requested public URLs and, for Parallel, a conversation session identifier. These can contain information from the person's request, so the Bot is told not to send private context public research does not need. Full conversations are not forwarded. Failures stay visible and are not silently retried through another provider.

## Adding a provider

A provider is a catalogue entry in `server/src/plugins/catalogue.ts`, plus its two tools in `RESEARCH_TOOLS` in `shared/research.ts` (`{ search, fetch, notes? }`, keyed by the entry's key). The table is shared because the app labels these tools too. Add `readTools` to the entry when its write tools cannot be listed exhaustively. A vendor that reads its key from its own header names it in `auth: { kind: "deployment-bearer", header }`. The Bot guidance, the skill roles and the transcript labels pick the new entry up with no other change.

Provider documentation: [Parallel](https://docs.parallel.ai/integrations/mcp/search-mcp), [Exa](https://exa.ai/docs/reference/exa-mcp), [Firecrawl](https://docs.firecrawl.dev/mcp-server).
