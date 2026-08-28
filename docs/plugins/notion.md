# Notion

A Bot with this connector granted reaches Notion **as the person asking**, through the hosted MCP
server Notion runs at `mcp.notion.com`, on the catalogue's default MCP transport. Two people asking
the same question get the pages their own accounts can see, and neither sees anything they could not
open themselves. Unlike Google Drive, this connector ships both read and write tools: the writing
tools are named in the catalogue, and the action policy governs every call the same as any other
plugin tool.

Setting it up takes two people, and neither can do the other's half:

| Who               | Does                                       | Where                        |
| ----------------- | ------------------------------------------- | ----------------------------- |
| An administrator  | Enables the connector                       | `/admin/plugins/notion`        |
| Each person       | Consents with their own Notion account      | `/settings/connected-accounts` |

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

## What an administrator does

### 1. Enable the connector in OpenBot

At `/admin/plugins/notion`, turn on **Enable for this deployment**. There is no client to register
and no secret to paste: this deployment introduces itself to Notion on first connect, over RFC 7591
dynamic client registration. The prerequisite is a public URL the redirect URI can be derived from —
`OPENBOT_PUBLIC_URL` if it is set, or the auth base URL it falls back to otherwise — nothing needs to
be registered at Notion ahead of time.

### 2. Connect your own account

On the same page, use **Your account** to connect your own Notion account before doing anything
else here. Unlike Google Drive's tool list, which is OpenBot's own code and needs no credential to
read, this connector's tool list is an answer from Notion's hosted server: refreshing it takes a
credential, and the refresh in the next step mints one from the connection belonging to whoever
presses the button — not whichever account happens to be connected here. That is a personal grant
like anybody else's, reaching only what your own account can see — not deployment configuration —
but it has to come first, because an administrator who presses Refresh tools without having
connected their own account is refused, not lent someone else's.

### 3. Press Refresh tools

This records the tool list Notion's hosted server advertises today, both reads and writes.

Notion has **no read-only scope**. Access is granted per page, at the moment somebody consents, not
by a scope string the way Google's `drive.readonly` is — so there is nothing at the vendor standing
behind a tool's read-or-write classification. The catalogue's write-tool list, plus the action
policy, is the **entire** write barrier for this connector.

That makes reconciling the catalogue's write-tool names against what the live list actually calls
them, on this first refresh, required rather than cosmetic. A name that has changed at the vendor is
the dangerous direction, not a safe one: `classifyTool` reads a tool Notion advertises but that no
longer matches an entry in the write list as a **read**, so an uncorrected rename quietly turns a
write into something the policy will pass through. The safe direction runs the other way — a tool
name the server never advertised at all still classifies as a write — but that is not the case this
refresh exists to catch.

### 4. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Every call then checks the grant, evaluates the action policy, and writes an
audit row.

## What each person does

At `/settings/connected-accounts`, Notion appears once an administrator has enabled it. Open it and
press **Connect**. That leaves OpenBot for Notion's own consent screen — the arrow on the button says
so — where the pages and databases to share are chosen, and returns to the same page, which then
reads **Connected**.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each
call, so withdrawing access at Notion takes effect on the next call rather than whenever a cache
expires.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
- [Notion's own guide](https://developers.notion.com/guides/mcp/build-mcp-client) to building an MCP
  client against its hosted server.
