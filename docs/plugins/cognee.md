# Cognee

A Bot with this connector granted reaches [Cognee](https://www.cognee.ai) **as the person asking**,
through the hosted MCP server Cognee runs at `mcp.aws.cognee.ai`, on the catalogue's default MCP
transport. Cognee keeps memory as a knowledge graph built from what was stored in it. Each person
signs in with their own Cognee account, and every call reaches that person's own Cognee Cloud
workspace, so two people asking the same question get what their own workspaces hold.

This is separate from the memory OpenBot keeps in CopilotKit Intelligence. Intelligence keeps a
person's threads and what a Bot learned about them. Cognee is a store the person already uses
elsewhere, for example from Claude Code, Codex or n8n, and that a Bot can now read from and add to.

Setting it up takes two people, and neither can do the other's half:

| Who               | Does                                       | Where                         |
| ----------------- | ------------------------------------------ | ----------------------------- |
| An administrator  | Enables the connector                      | `/admin/plugins/cognee`       |
| Each person       | Signs in with their own Cognee account     | `/connections`                |

## The tools

The hosted server offers four tools. The catalogue names all four, so a tool Cognee adds later is
treated as a write until somebody reads it and lists it.

| Tool             | What it does                                                    | Treated as |
| ---------------- | --------------------------------------------------------------- | ---------- |
| `recall`         | Searches the person's memory and answers from it                | Read       |
| `check_ingestion_status` | Reports progress of something stored with `remember` in the background | Read |
| `remember`       | Stores text or a file in the person's memory                    | Write      |
| `forget`         | Deletes one item, one dataset, or everything the person owns    | Write      |

`forget` with `everything` set deletes all of a person's Cognee data, in Cognee and not only in
OpenBot, so it asks first like every other write.

## What an administrator does

### 1. Enable the connector in OpenBot

At `/admin/plugins/cognee`, turn on **Enable for this deployment**. There is no client to register
and no key to paste: this deployment introduces itself to Cognee on first connect, over RFC 7591
dynamic client registration. The prerequisite is a public URL the redirect URI can be derived from:
`OPENBOT_PUBLIC_URL` if it is set, or the auth base URL it falls back to otherwise.

### 2. Connect your own account

On the same page, use **Your account** to connect your own Cognee account. That leaves OpenBot for
Cognee's sign-in and consent page and comes back here. Refreshing the tool list in the next step
needs a credential, and it uses the connection of whoever presses the button, so this comes first.

### 3. Press Refresh tools

This records the tool list Cognee's hosted server advertises today. Check it against the table above.
A name that has changed at Cognee is a write until the catalogue is updated, which is the safe
direction.

### 4. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Every call then checks the grant, evaluates the action policy, and writes an
audit row.

## What each person does

At `/connections`, Cognee appears once an administrator has enabled it. Open it and press
**Connect**, sign in to Cognee, and allow access. The page then reads **Connected**.

A person without a Cognee account can make one at [cognee.ai](https://www.cognee.ai) before
connecting.

## Try it

1. In a conversation with the Bot: "Remember that the staging migration is owned by Ravit."
2. In a **new** conversation: "Who owns the staging migration?"

Use a new conversation, so the answer cannot come from the conversation's own history. Cognee builds
its graph in the background, so a fact can take a short while to become recallable.

Name Cognee in the request ("Use Cognee to remember…"). A Bot also has OpenBot's own memory, and
without the name it may save there instead.

`remember` files into a dataset named after the client, `openbot_memory`, unless the Bot names
another. `recall` searches every dataset the person owns, so a Bot can find what the person stored
from Claude Code, Codex or any other Cognee client.

## See also

- [Notion](notion.md), the other connector on a hosted MCP server with dynamic client registration.
- [Configuration](../configuration.md): `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
- [Cognee's guide](https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp) to its hosted MCP
  server.
