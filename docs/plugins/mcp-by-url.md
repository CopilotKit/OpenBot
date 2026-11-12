# MCP servers added by URL

Any remote MCP server OpenBot doesn't list (Figma's, Fireflies', your own) can be added by its
address from **Connections → Add server**, and given to Bots like any other app.

OpenBot asks the server, with no credential, how it is reached:

| The server answers | OpenBot does |
| --- | --- |
| A normal MCP reply | Adds it and lists its tools at once. Bots use it as it is. |
| `401` with an OAuth challenge (the [MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization)) | Discovers its authorization server (RFC 9728 protected resource metadata, then RFC 8414 or OpenID discovery), registers itself there (RFC 7591), and sends the person to its sign-in page. Each person signs in with their own account; every call runs on their token. |
| `401` with no sign-in to follow | Asks for a key. The key is the server's own, used by every Bot that uses it, so in the team edition only an admin may give one. |

## Signing in

The consent request uses PKCE (S256) and the `resource` parameter (RFC 8707). The callback checks the
`iss` the server sends back against the issuer it discovered (RFC 9207) before redeeming the code.
Discovery, registration, the authorization URL, the code exchange and refresh are the MCP TypeScript
SDK's own (`@modelcontextprotocol/sdk/client/auth`), in `server/src/plugins/remote-oauth.ts`.

Each person's token set (access token, refresh token, expiry) is encrypted in the vault as an
`mcp_user_token`, like the catalogue's OAuth apps. The access token is used until it is about to
expire, then refreshed. A server that stops honouring the refresh token asks the person to reconnect.

Registration happens when the server is added, so a server that only accepts apps it has approved
says so on the form, and nothing is left behind. Figma's remote server is one: it only accepts the
clients in its own catalogue, and refuses OpenBot's registration with `403`.

In OpenBot Desktop the sign-in opens in the person's browser and hands them back to the Desktop
window afterwards, the same way the Composio and Arcade connections do.

## Safety

Every address OpenBot fetches, the server's and every endpoint its metadata names, is held to the
same floor as the server's own address: https only, no IP literals, no `localhost`, no internal
suffixes, no cloud metadata hosts, no credentials in the address, and no redirects followed. A server
whose metadata names a resource for a different address, or whose authorization server metadata names
a different issuer, is refused.

`OPENBOT_ALLOW_LOOPBACK_MCP=1` admits `http://127.0.0.1:<port>` and `[::1]` for development and the
end-to-end tests (`server/tests/support/oauth-mcp-server.ts` is a real OAuth MCP server for them).
Leave it unset anywhere people use OpenBot.

## The MCP allowlist (team edition)

With **Admin → Apps → MCP servers → Only approved servers** on, a server can only be added by its
address once an admin has approved that address there (**Approve a server by its address**). An admin
adding one is offered **Approve and add** on the form. A server added at an approved address is
approved by the same entry, so its calls go through. The personal edition has no allowlist.
