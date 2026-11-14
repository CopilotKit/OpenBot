# Bots

A Bot has a durable profile and a standing role. The role is sent with every run, so nobody has to
restate the job in each conversation. What a person sees of this is the Bot's **Setup**; see
[How OpenBot works](how-openbot-works.md) for the rest of what a Bot has.

In the code and the database a Bot is often a "coworker" or an "agent", and a conversation a
"channel". Those names stay in the tables and endpoints below.

## Data model

| Piece                | Table                           | Purpose                                                                                  |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | Name, type (built-in, remote AG-UI or remote Mastra), endpoint or prompt, optional key reference. |
| Profile              | `agent_profiles`                | Title, role, avatar seed, owner, visibility, isolation, and soft deletion.               |
| Personal roster      | `agent_preferences`             | Per-user hidden and pinned state.                                                        |
| Team publication     | `team_bot_publications`         | A Bot its owner has published to the whole team or to named people and groups.          |
| Channel              | `channels`                      | Conversation membership and coworker binding.                                            |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                                               |

Package-provided Bots are public and ownerless. A Bot a person makes is owned by that person.

## Standing role

A remote Bot receives a system message derived from its name, title and role description
(`standingRoleMessage` in `server/src/copilot.ts`):

```text
<identity>
You are Expense Manager, Finance Operations. People call you "Expense Manager" or "the Expense Manager Bot". A request to ask, message or hand work to Expense Manager is a request to you, so answer it yourself.
</identity>

<role>
Review receipts, categorize expenses, and prepare reimbursement reports.

Your role applies in every conversation, and each message sets the task within it. What the person says in the conversation comes before anything remembered about them.
</role>
```

When OpenBot knows the framework behind the endpoint, the identity block also names it.

The deployment, not the package, then appends the working rules every Bot gets, each in a tag of
its own (`workingGuidance` in `shared/bot-prompt.ts`): how to work, when to ask, where answers come
from, how to format an answer, when to use subagents, and how to read the untrusted-content envelope
its tool results carry. The sources block tells the Bot to say where each answer came from and to
mark plainly anything it answers from its own knowledge rather than from a source. The asking block
tells it that, for the apps and tools OpenBot gives it, OpenBot asks the person before a delete,
send, share, post or payment unless they already allowed that kind of action, and that it should
ask itself before a tool of its own does something that cannot be undone. Being deployment-wide,
none of these can be forgotten from the next Bot somebody adds.

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided Bots cannot be edited or deleted through the product, except the personal edition's starter Personal Assistant, which its person can edit.

An owner can also publish a Bot as a Team Bot, to everybody signed in or to named people and groups
(`/api/team-bots`, the Bot's **Sharing** page). Publishing is a separate, revocable record; the Bot's own
visibility is unchanged by it. A published Bot stays invisible to teammates until it has a role
description and a name other than a placeholder such as "New Bot".

A Team Bot reaches a Personal app through its **owner's own account** when the owner has connected
it — for everyone it is published to, triggers included — and otherwise through the asker's own
account, with their consent. That holds for an app an administrator granted the Bot. An app the
owner gave the Bot themselves always uses the asker's own account, so publishing a Bot never hands
teammates the owner's account. A Shared app is the governed alternative: one account that belongs to
the deployment, with an administrator approving who may use it through each Bot. See
[Composio → Shared apps](plugins/composio.md#shared-apps).

## Conversations

Starting a conversation creates a new channel and Intelligence thread. Two conversations with the
same Bot stay separate.

Each conversation routes through a channel-local proxy agent id, pinned to that channel's thread id,
then forwards to the Bot's runtime id.

## Deleting and hiding

Deleting is soft. The Bot stops running, but its existing conversations remain readable for their members and restore as tombstones.

Hiding and pinning are personal roster state. Hiding removes the Bot from one person's list without disabling it for anyone else; pinning moves it into the **Pinned** section at the top of `/bots` for that person only. A Team Bot an administrator assigned to a group is always pinned for its members.

## Default endpoint

Bots made in the product use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:4201/
```

That is the LangGraph harness, `agent-langgraph-agui`, which runs a real framework and its own tool
loop.

The URL is optional. Set it with `MANAGED_AGENT_TOKEN`, or leave it unset: a Bot made in the
product with no endpoint of its own then runs inside the server as a built-in Bot on its role
description, and a package Bot whose endpoint expands to nothing is omitted rather than registered
against a missing host. A leftover token with no URL is ignored. Package-provided Bots otherwise use
their own `agents.yaml` configuration.

## Register an external AG-UI agent

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui
```

In the product, create a Bot from `/bots` and edit it from its page's **Setup**, and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## What a role does not grant

A Bot's role grants it nothing. What it may use is set separately, on the Bot's page, in Settings
and, in the team edition, in Admin:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- app and MCP tools are granted per Bot by administrators, or by a Bot's owner for an app an administrator opened to owners;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).
