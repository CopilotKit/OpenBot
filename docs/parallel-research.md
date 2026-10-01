# Public-web research with Parallel

Parallel provides public-web search and extraction for OpenBot. The standard built-in Bot guidance selects it for public-web research when both its `web_search` and `web_fetch` tools are granted, unless the user explicitly chooses another authorized provider. The shipped Research Desk example also includes a public-web research skill. This configuration is conditional on ordinary authorization: no existing Bot receives new access automatically.

## Enable research

1. As an administrator, open Plugins and add **Parallel Search** from the catalogue. This pins `https://search.parallel.ai/mcp` and discovers its tools. No API key is needed for anonymous light use.
2. Grant **web_search** and **web_fetch** to the Bots that should research the public web. For the shipped fintech package, select **Research Desk**. Its `research-public-web` skill already declares these tools; the declaration alone grants no access.
3. Ask the Bot to research a topic. It should search, read selected sources, and cite their URLs. Run `/research-public-web` to explicitly select the example skill if your deployment has many tools.

For production or higher limits, instead add **Parallel Search (API key)**, with your Parallel API key stored through the existing deployment credential flow. Grant its two tools and remove the anonymous grants. Both use the official endpoint; the authenticated entry sends the key as a Bearer token. If both are granted, the guidance selects the authenticated connector. Keys remain in the server-side credential vault.

## Choice and controls

Administrators can revoke either tool, remove the connector, or grant another provider. Users can explicitly request a different authorized provider. Existing tool selection, action policies, audit records, vendor error handling, and background-run authorization are unchanged. Every call goes through `PluginStore.callTool`; no raw MCP server is added to the agent configuration.

The provider receives model-selected objectives, search queries, requested public URLs and a conversation session identifier. These arguments can contain information from the user's request: avoid sending private context that is not needed for public research. Full conversations are not automatically forwarded. Free anonymous access has provider-managed limits; failures remain visible and are not silently retried through another provider. Source URLs and excerpts use the existing tool-result rendering; this change adds no custom source-card UI.

See [Parallel's official Search MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp) for the two tools, free access, API-key authentication and limits.
