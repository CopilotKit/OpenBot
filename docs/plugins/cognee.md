# Cognee

[Cognee](https://www.cognee.ai) gives a Bot long-term memory for the material it works with. Ask a
Bot to remember a decision, a set of notes or a file (up to 10 MB), and Cognee builds a knowledge
graph from it. Later, in any conversation and with any Bot that has this connector, a Bot can search
that graph and answer from it. All of it is stored and searched **as the person asking**, in their
own Cognee account.

It sits beside the memory OpenBot keeps in CopilotKit Intelligence and does not replace it. OpenBot's
own memory keeps facts about the person, which they can review and edit. Cognee keeps what the
person asks a Bot to store. A Bot uses OpenBot's own memory unless it is asked to use Cognee.

Cognee also works outside OpenBot. A person who uses it from other AI tools, for example Claude Code,
Codex or n8n, reaches the same memory from all of them. See
[Memory flows both ways](#memory-flows-both-ways).

The Bot reaches Cognee through the hosted MCP server Cognee runs at `mcp.aws.cognee.ai`, on the
catalogue's default MCP transport. That is one address for every customer: each person signs in with
their own Cognee account, and Cognee sends every call to that person's current workspace.

## What a Bot can reach

- `recall` searches everything the person's Cognee account can access in their current workspace.
  That is what their Bots stored, and every other dataset too, so it includes anything the person
  stored from other tools. A workspace can have several members, so it can also include memory that
  is not theirs alone.
- `check_ingestion_status` reports the progress of something stored with `remember` in the
  background.

Two people asking the same question each get what their own account can access. Nobody reaches a
workspace they are not a member of.

## What a Bot can change or delete

- `remember` stores text or a file in the person's Cognee memory. It files into a dataset named
  after the client, `openbot_memory`, unless the Bot names another. It is stored at Cognee, so the
  person's other tools can find it, and turning the connector off in OpenBot does not remove it.
- `forget` deletes one item, one dataset, or, with `everything` set, all the data the person owns.
  It is not limited to what OpenBot stored. It can delete memory the person saved from every other
  client, and it deletes it at Cognee, where OpenBot cannot bring it back.

## What protects it

Cognee has **no read-only scope**. Its server advertises one scope, `openid`, and a connection is
the person's whole access to their workspace, so nothing at Cognee stands behind a tool's
read-or-write classification. The catalogue's tool lists, plus the action policy, are the **entire**
write barrier for this connector, the same as for [Notion](notion.md).

| Tool                     | Treated as         | Asks the person first                                                    |
| ------------------------ | ------------------ | ------------------------------------------------------------------------ |
| `recall`                 | Read               | No                                                                       |
| `check_ingestion_status` | Read               | No                                                                       |
| `remember`               | Write              | Only when Always ask before making changes, Auto-review or a rule says so |
| `forget`                 | Write, destructive | Every time: **Allow once** or **Deny**                                   |

- **A Bot has no Cognee tool until it is granted one**, and each tool is granted on its own. A Bot
  that should only search memory gets `recall` and nothing else. Leave `forget` ungranted unless a
  Bot needs it.
- **The catalogue names the two reads.** Every other tool the server advertises is a write,
  including one Cognee adds later, until somebody reads it and lists it.
- **`forget` asks every time.** Cognee's server marks it destructive, OpenBot records that on
  Refresh tools, and a tool its app marks destructive always asks, the same as deleting does. No
  setting, rule or reviewer switches that off, and it never offers **Always allow here**. The name
  `forget` is not one of the words OpenBot recognises as deleting, so this depends on Cognee's mark.
  The server sent it on 2026-11-09.
- **`remember` is an ordinary change.** With the default settings a Bot stores to Cognee without
  asking. Turn on Always ask before making changes or Auto-review, or add a rule, to make it ask. A
  task started from a check-in asks before every change.
- Every call checks the grant, evaluates the action policy, and writes an audit row.

See [Approvals](../approvals.md) for the order these are decided in.

## Memory flows both ways

This matters to a person who also uses Cognee from other AI tools. Their Bots and those tools work
on the same memory.

- **Out of OpenBot.** What a Bot stores with `remember` is in the person's Cognee workspace, in
  `openbot_memory`. Their other Cognee clients search every dataset the person can access, so they
  find it there.
- **Into OpenBot.** `recall` searches the datasets those clients write to as well, so a Bot can
  answer from something the person stored from Claude Code or Codex.
- **Deleting reaches both.** `forget` works on the same shared memory, which is why it asks.

Only what goes through these tools moves. OpenBot's own memory is not copied to Cognee, and Cognee
memory is not copied into OpenBot.

## Setting it up

Setting it up takes two people, and neither can do the other's half:

| Who               | Does                                       | Where                         |
| ----------------- | ------------------------------------------ | ----------------------------- |
| An administrator  | Enables the connector                      | `/admin/plugins/cognee`       |
| Each person       | Signs in with their own Cognee account     | `/connections`                |

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

This records the tool list Cognee's hosted server advertises today, and whether it marks each tool
destructive. Check the list against the table above: four tools, with `recall` and
`check_ingestion_status` shown as reads and `remember` and `forget` as changes. A name that has
changed at Cognee is a write until the catalogue is updated, which is the safe direction.

### 4. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Decide here whether a Bot gets `forget`.

## What each person does

At `/connections`, Cognee appears once an administrator has enabled it. Open it and press
**Connect**, sign in to Cognee, and allow access. The page then reads **Connected**.

A person without a Cognee account can make one at [cognee.ai](https://www.cognee.ai) before
connecting.

## Try it

Before you start: an administrator has granted the Bot `remember` and `recall`, and your own account
reads **Connected** at `/connections`.

1. In a conversation with the Bot: "Use Cognee to remember that the staging migration is owned by
   Ravit." Say "Use Cognee". A Bot also has OpenBot's own memory, and without the name it may save
   there instead. The conversation shows a **Remember** step marked `cognee` when it went to Cognee.
2. Wait about a minute. Cognee builds its graph in the background, so a fact can take a short while
   to become recallable. The Bot's reply says so when processing is still running.
3. In a **new** conversation: "Use Cognee to recall who owns the staging migration." A new
   conversation, so the answer cannot come from the conversation's own history.

If the Bot finds nothing, wait another minute and ask again in the same conversation.

## See also

- [Approvals](../approvals.md): what always asks, and the settings that make ordinary changes ask.
- [Notion](notion.md), the other connector on a hosted MCP server with dynamic client registration.
- [Configuration](../configuration.md): `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
- [Cognee's guide](https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp) to its hosted MCP
  server.
