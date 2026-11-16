# Add a custom MCP server

Open **Admin → Apps → More apps → Add custom MCP server**, or use **Add MCP
server** beside the Apps heading on Browse apps. Both open `/admin/plugins/new`
inside OpenBot, with Back and Cancel returning to Apps. The direct address
`/admin/plugins/composio/add-mcp-server` also opens that page.

Connections keeps its existing **Add server** action at `/connections/new`.
These entry points share the same native registration form and API.

Give the server a name and its public HTTPS MCP endpoint. For example, DeepWiki's
[public MCP server](https://mcp.deepwiki.com/) uses the name `DeepWiki` and address
`https://mcp.deepwiki.com/mcp`, without an access token. OpenBot asks the server
how it is reached and opens its tools, or its sign-in page when required.

Only an administrator can supply a shared access token. Existing URL checks,
the MCP allowlist and Bot access controls still apply. When the allowlist blocks
an address, the form offers an administrator the existing approval step.
