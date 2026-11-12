# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                                                  |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | Name, type (built-in, remote AG-UI or remote Mastra), endpoint or prompt, optional key reference. |
| Profile              | `agent_profiles`                | Title, role, avatar seed, owner, visibility, isolation, and soft deletion.               |
| Personal roster      | `agent_preferences`             | Per-user hidden and pinned state.                                                        |
| Team publication     | `team_bot_publications`         | A Bot its owner has published to the whole team or to named people and groups.          |
| Channel              | `channels`                      | Conversation membership and coworker binding.                                            |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                                               |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Standing role

Remote coworkers receive a system message derived from their name, title and role description
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
its tool results carry. The sources block tells the coworker to say where each answer came from and
to mark plainly anything it answers from its own knowledge rather than from a source. The asking
block tells it that, for the apps and tools OpenBot gives it, OpenBot asks the person before a
delete, send, share, post or payment unless they already allowed that kind of action, and that it
should ask itself before a tool of its own does something that cannot be undone. Being deployment-wide, none of these can be forgotten
from the next coworker somebody adds.

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided agents cannot be edited or deleted through the product, except the personal edition's starter Personal Assistant, which its person can edit.

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

## Channels

Starting a channel creates a new conversation and Intelligence thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Grouping conversations into projects

The conversation sidebar draws three collapsible sections in a fixed order: **Group chats**, **Direct chats**, then **Projects**. A conversation is drawn once. One that is filed in one of the reader's projects appears under that project and nowhere else; everything else is a group chat when it has more than one person in it (`memberCount` above one, the reader included) or more than one Bot, and a direct chat otherwise. Both answers come from fields the roster already carries, so classifying the sidebar costs no request per row.

A project is one person's folder, not a property of the conversation. Filing is recorded in `channel_projects` — `(project_id, channel_id, owner_user_id)`, unique per channel and owner, so the same channel can sit in one folder for one reader and in no folder for everybody else. The alternative, a `project_id` column on `channels`, would force a single folder on everyone who can see the channel, which is why it was not used. For the same reason nothing about a project grants access: every channel route still resolves the caller in `channel_memberships`, and a project endpoint names only channels the caller is a member of — ids, never titles, so a folder cannot become a way to read a conversation's name.

| Route                            | What it does                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`              | The caller's folders with the ids of the conversations filed in them, in the caller's own order.                      |
| `POST /api/projects`             | Makes a folder for the caller.                                                                                        |
| `PATCH /api/projects/:id`        | Renames the caller's folder. Anybody else's is `404`, not `403`, so the answer does not confirm it exists.             |
| `DELETE /api/projects/:id`       | Drops the folder. Its conversations are untouched and return to Group or Direct.                                     |
| `PATCH /api/channels/:id/project`| Files a conversation into one of the caller's folders, or takes it out (`projectId: null`). Needs channel membership. |

Deleting a folder deletes filing rows through the foreign key; the conversations and their memberships are not touched, so a deleted folder leaves nothing for anybody to clean up and nothing for a member to lose.

Which sections a person keeps folded is saved on their account (`sidebarSections` in their user preferences), not in the browser's storage, so a sidebar folded on a laptop is folded on the desktop too. Typing in the sidebar search opens every section for as long as the box holds text — a match inside a folded section is a result the person would otherwise be told about and not shown — and the fold they chose comes back when the box is cleared, because the search is drawn over the saved state rather than written into it.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding and pinning are personal roster state. Hiding removes the coworker from one user's list without disabling the coworker for anyone else; pinning moves it into the **Pinned** section at the top of `/bots` for that user only. A Team Bot an administrator assigned to a group is always pinned for its members.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui
```

That is `agent-langgraph`, which runs a real framework and its own tool loop. The proof-of-concept on
`4200` hand-writes the protocol and leaves the loop to whatever is watching, so it is a reference
rather than something to build a deployment on.

The URL is optional. Set it with `MANAGED_AGENT_TOKEN`, or leave it unset: a product-created
coworker with no endpoint of its own then runs inside the server as a built-in Bot on its role
description, and a package agent whose endpoint expands to nothing is omitted
rather than registered against a missing host. A leftover token with no URL is ignored.
Package-provided agents otherwise use their own `agents.yaml` configuration.

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

In the product, create a coworker from `/bots` and edit it from its page's **Setup**, and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- app and MCP tools are granted per Bot by administrators, or by a Bot's owner for an app an administrator opened to owners;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).
