# Notion

A Bot with this connector granted reaches Notion **as the person asking**, through the hosted MCP
server Notion runs at `mcp.notion.com`, on the catalogue's default MCP transport. Two people asking
the same question get the pages their own accounts can see, and neither sees anything they could not
open themselves. Unlike Google Drive, this connector ships both read and write tools: the writing
tools are named in the catalogue, and the action policy governs every call the same as any other
plugin tool.

This built-in connector is in the team edition only. OpenBot Personal doesn't list it on
Connections: it reaches Notion through Composio's directory instead, so the same app isn't listed twice.
An install that already added this connector keeps it listed and working.

Setting it up takes two people, and neither can do the other's half:

| Who               | Does                                       | Where                        |
| ----------------- | ------------------------------------------- | ----------------------------- |
| An administrator  | Enables the connector                       | `/admin/plugins/notion`        |
| Each person       | Consents with their own Notion account      | `/connections` |

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

## What an administrator does

### 1. Enable the connector in OpenBot

At `/admin/plugins/notion`, turn on **Enable for this deployment**. There is no client to register
and no secret to paste: this deployment introduces itself to Notion on first connect, over RFC 7591
dynamic client registration. The prerequisite is a public URL the redirect URI can be derived from —
`OPENBOT_PUBLIC_URL` if it is set, or the auth base URL it falls back to otherwise — nothing needs to
be registered at Notion ahead of time.

### 2. Connect your own account

On the same page, use **Your account** to connect your own Notion account. Unlike Google Drive's
tool list, which is OpenBot's own code and needs no credential to read, this connector's tool list
is an answer from Notion's hosted server, so it can only be read with somebody's connection. While
no tools are recorded, the first connection made here or at `/connections` lists them as the person
who just connected, so the page they land on already shows them. That is a personal grant like
anybody else's, reaching only what your own account can see, and not deployment configuration.

### 3. Refresh tools when Notion changes them

**Refresh tools** records the tool list Notion's hosted server advertises today, both reads and
writes, replacing what was recorded. It asks with the connection belonging to whoever presses the
button, not whichever account happens to be connected here, so an administrator who presses it
without having connected their own account is refused, not lent someone else's.

Notion has **no read-only scope**. Access is granted per page, at the moment somebody consents, not
by a scope string the way Google's `drive.readonly` is, so there is nothing at the vendor standing
behind a tool's read-or-write classification. The catalogue's lists, plus the action policy, are the
**entire** write barrier for this connector.

The catalogue names Notion's writes and its reads, and `classifyTool` reads a tool Notion advertises
on neither list as a **write**. So a tool Notion adds or renames later is a write until somebody
reviews it and lists it as a read, and a renamed write cannot slip through as a read. What a
refresh can still turn up is the other direction: a new read that is treated as a change (it asks
wherever changes ask, and a check-in never calls it) until the catalogue lists it.

### 4. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Every call then checks the grant, evaluates the action policy, and writes an
audit row.

## What each person does

At `/connections`, Notion appears once an administrator has enabled it. Open it and
press **Connect**. That leaves OpenBot for Notion's own consent screen — the arrow on the button says
so — where the pages and databases to share are chosen, and returns to the same page, which then
reads **Connected**.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each
call, so withdrawing access at Notion takes effect on the next call rather than whenever a cache
expires.

### Disconnecting

**Not built yet.** Until it is, remove OpenBot in your Notion account's third-party access settings,
which stops this deployment reading anything on the next call. The page says the same thing rather
than offering a control that would report access withdrawn when it had not been.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
- [Notion's own guide](https://developers.notion.com/guides/mcp/build-mcp-client) to building an MCP
  client against its hosted server.
