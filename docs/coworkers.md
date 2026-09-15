# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                            |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

A further provenance block is appended by the deployment rather than the package: it tells the
coworker to say where each answer came from, to mark plainly anything it answers from its own
knowledge rather than from a source, and never to present the latter as the former. Being deployment-wide,
it cannot be forgotten from the next coworker somebody adds.

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided agents cannot be edited or deleted through the product.

## Channels

Starting a channel creates a new conversation and Intelligence thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding is personal roster state. It removes the coworker from one user's list without disabling the coworker for anyone else.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui
```

That is `agent-langgraph`, which runs a real framework and its own tool loop. The proof-of-concept on
`4200` hand-writes the protocol and leaves the loop to whatever is watching, so it is a reference
rather than something to build a deployment on.

The URL is optional. Set it with `MANAGED_AGENT_TOKEN`, or leave it unset: product-created coworkers
then need their own endpoint, and a package agent whose endpoint expands to nothing is omitted
rather than registered against a missing host. A leftover token with no URL is ignored.
Package-provided agents otherwise use their own `agents.yaml` configuration.

## Cloud subscription coworkers

The default tenant package has optional Codex, Claude, and Grok coworkers. Each one appears only
when its own endpoint and gateway token pair is set. This supports a staged release: configure
Codex, verify it, then add Claude, then Grok.

```dotenv
CODEX_AGENT_AG_UI_URL=http://subscription-workers.openbot.internal:4210/ag-ui
CODEX_AGENT_TOKEN=...
CLAUDE_AGENT_AG_UI_URL=http://subscription-workers.openbot.internal:4211/ag-ui
CLAUDE_AGENT_TOKEN=...
GROK_AGENT_AG_UI_URL=http://subscription-workers.openbot.internal:4212/ag-ui
GROK_AGENT_TOKEN=...
AGENT_ENDPOINT_ALLOWED_HOSTS=subscription-workers.openbot.internal:4210,subscription-workers.openbot.internal:4211,subscription-workers.openbot.internal:4212
```

The private Route 53 name is stable while the worker host changes. The port list is exact: listing
`4210` does not admit `4211`, another host, or any other private address. Metadata addresses remain
blocked under all settings.

OpenBot holds only the gateway bearer values and sends each one only to its exact configured URL.
Use deployment secrets for them. The official coding programs own their subscription login state on
the worker host; do not put provider tokens or login files in OpenBot, the tenant package, or these
gateway settings.

These package coworkers are deployment-owned. Their endpoint and gateway token come from the
environment, not from the coworker edit form. Customer-created remote coworkers keep using the
write-only authorization header flow and encrypted credential vault described below.

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

In the product, create or edit a coworker from `/agents` and set:

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
- MCP tools are granted per Bot by administrators;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).
