# Architecture

OpenBot combines a React app, a Hono API server, PostgreSQL, CopilotKit Intelligence, AG-UI Bot endpoints, and governed browser computers.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/architecture-dark.svg">
  <img src="../assets/architecture-light.svg" alt="A turn goes from the app to the server, which sends it to a Bot over AG-UI. Every tool call the Bot makes returns through the gateway, which resolves the target, decides it against the configured policy, records an audit row, and only then acts, or refuses and names the rule. Allowed actions reach that Bot's own computer, one container each holding its own Chromium, logins and workspace, created by the supervisor. Every decision lands in PostgreSQL; threads and memory live in CopilotKit Intelligence.">
</picture>

Regenerate it with `bun run diagram` after changing anything it shows.

## Services and ports

| Component                | Port                       | Responsibility                                                                                                                              |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                    | 3010                       | React/Vite interface for channels, Bot chat, live screen, settings, and admin pages.                                                        |
| `server`                 | 3001                       | API, CopilotKit runtime, auth, roles, tenant package, coworkers, channels, policy, audit, credentials, plugins, components, and connectors. |
| `agent-computer`         | 4100                       | Chromium, `/workspace`, browser profile, screenshots, snapshots, and file tools.                                                            |
| `agent-bot`              | 4200                       | Proof-of-concept AG-UI Bot.                                                                                                                     |
| `agent-langgraph`        | 4201                       | LangGraph AG-UI Bot.                                                                                                                        |
| `supervisor`             | 4500 host / 4300 container | Creates, stops, resets, and lists per-Bot computer containers.                                                                              |
| PostgreSQL with pgvector | 5432                       | Product data, audit rows, credentials, policy, grants, channels, and components.                                           |
| CopilotKit Intelligence  | external                   | Durable threads, memory, and realtime gateway.                                                                                              |

`scripts/start.sh` starts PostgreSQL, `agent-computer`, `agent-bot`, `agent-langgraph`, and the supervisor through Docker Compose, then starts `server` and `app` on the host.

The compose file also defines optional SPIRE services. `start.sh` does not start them.

## Runtime flow

1. The app opens a channel or direct Bot session.
2. The server resolves the signed-in actor and selected coworker.
3. CopilotKit runtime sends the turn to the configured AG-UI endpoint.
4. The surface registers available frontend tools: browser tools, MCP tools, and components granted to that Bot.
5. Acting browser/file/MCP calls return to the server for authorization and audit.
6. The server streams results back to the app and Intelligence thread.

## Browser action governance

The computer itself does not decide policy. The server gateway is the action boundary:

1. resolve the target from the server-held snapshot or request subject;
2. evaluate the current action policy;
3. write an audit row for the decision;
4. call the computer only when the decision forwards;
5. write a second audit row if a forwarded action fails.

Policy rules can inspect:

- `tool.name`
- `intent`
- `bot.id`
- `actor.id`
- `page.url`, `page.host`
- `element.ref`, `element.role`, `element.name`, `element.type`
- `key`
- `file.path`, `file.name`, `file.extension`
- `mcp.server`, `mcp.tool`, `mcp.effect`

Rules use CEL expressions plus case-insensitive `contains()` and `matches()`.
Deny rules are evaluated before allow rules. The policy engine fails closed: a
missing or empty policy permits nothing, a broken deny rule denies, and a broken
allow rule does not permit. OpenBot's shipped startup default is explicit:
`deny: []` and `allow: ["true"]`, unless `AGENT_COMPUTER_POLICY` or a saved
administrator policy replaces it. A malformed configured policy stops server
startup.

## Computers

`agent-computer` requires `COMPUTER_TOKEN` and permits only `/health` without it. Docker Compose binds it to `127.0.0.1:4100`.

Compose puts it on a different network from PostgreSQL. A Bot has a shell, and a shell reaches whatever its container reaches, so the database is on a `data` network carrying only itself and `migrate`, and everything else is on `default`. A deployment that runs the API server inside Compose rather than on the host joins it to both, which is the one place the two meet.

With `COMPUTER_SUPERVISOR_URL`, each Bot gets its own computer container, workspace volume, and browser profile. Without it, all Bots share `AGENT_COMPUTER_URL`.

A command on the computer inherits PATH, locale and terminal names, and the proxy variables, not the rest of the process environment. Userinfo is stripped from a proxy URL. `COMPUTER_SHELL_ENV` names anything else a deployment wants passed.

The supervisor exposes only ensure, stop, reset, and list operations. It holds the Docker socket, so do not expose it outside the deployment network: Docker Compose binds it to `127.0.0.1:4500`, and a deployment running the server inside the compose network reaches it as `supervisor:4300` and needs no published port at all. Set `COMPUTER_RUNTIME=runsc` to run computers under gVisor on hosts that support it.

## Human control and secrets

Handovers are audited as control events:

- `computer.help_requested`
- `computer.control_taken`
- `computer.control_released`

While a person controls the browser, Bot actions are refused rather than queued.

Secret entry is separate from chat content. The audit trail records that a secret was requested or supplied and the character count, not the secret value.

## Watching a Bot work

Two surfaces beside the conversation. The screen is the live browser, proxied over a websocket and gated on the same question as every other route about that Bot. The Activity tab is what the Bot did away from the browser: every command with its output and exit code, every file read, write and listing, newest first.

Activity is held in the browser for the open conversation and is gone on reload. It is a window rather than a record; the record is the audit trail, which is server-side, survives restarts, and is what an investigation reads. A saved file contributes its path and size and never its contents, matching the write route, which declines to echo them because a Bot may be saving something it was told in confidence.

## Coworkers and channels

A coworker is a durable Bot profile:

- `agents` stores runtime identity and endpoint/key reference.
- `agent_profiles` stores name, title, role, owner, visibility, and deletion state.
- `agent_preferences` stores per-user roster state.

A channel is a conversation with one coworker and a CopilotKit Intelligence thread mapping. Starting a new channel creates a new thread.

Who may reach one is decided by membership: every channel route resolves the caller in
`channel_memberships` and refuses without a row. `channels.allowed_groups` is declared in the
tenant package and stored, and is not part of that decision — `users.groups` is never populated by
any sign-in path, so a group-based rule has nothing to evaluate. Treat it as a declaration waiting
on group membership from the identity provider, not as a control that is running.

See [coworkers.md](coworkers.md).

## Components

Components are frontend tools a Bot can call instead of answering only in prose.

Sources:

- compiled React components in `app/src/components/gallery/`;
- sandboxed components authored and published from `/admin/playground`.

Governance:

- compiled components are published when first seen by the app catalogue sync;
- sandboxed components are saved as drafts and become usable only after publish;
- every call asks the server whether the component exists, is published, and is not withheld from the Bot;
- component data functions require a separate per-component grant.

The shipped component data functions read the audit trail: `botActivity` and `recentRefusals`.

## One Bot handing work to another

A Bot can address another Bot, and the addressed one answers for itself in the same conversation
rather than the first relaying text on its behalf.

`message_bot` is offered beside a Bot's granted tools, so which Bots may reach which is an ordinary
grant: `plugin_grants` with a `bot` kind. A Bot granted nobody is offered nothing.

What it takes is typed. The asking model names the task, anything that bounds it and what a good
answer looks like, rather than writing a paragraph. Free text is the commonest way a handoff goes
quietly wrong: the receiving Bot infers the intent, guesses the constraints, and when it guesses
wrong it does not fail, it answers something else confidently.

Four things are decided by the deployment and never by the model:

- **Who is being addressed**, resolved against the roster the asking person may see. A Bot must not
  reach a Bot its person cannot, or this is a way around agent visibility. A Bot that does not exist
  and one that is not theirs to see are refused in the same words, so this cannot enumerate the
  roster.
- **Where the answer lands**, from the signed run assertion. Otherwise a Bot could drop a turn into a
  conversation it was never part of.
- **Who is asking**, stamped from the row this deployment wrote. A Bot able to write its own
  attribution could claim to be another one.
- **How deep the chain is**, also from the assertion, which is what stops A asking B asking C asking
  A for ever.

The second Bot runs as the same person, with its own role and its own grants, so it sees what that
person may see and no more.

**A hop is claimed work, not a callback.** It is a row on the same queue the idle-computer culler
uses: the Bot being addressed is very unlikely to be on the pod that addressed it, and a hop held in
memory is lost the moment either is rescheduled. Every replica sweeps for hops and the queue decides
which gets which. The lease is renewed for as long as the run takes, because a run is minutes and a
lapsed lease hands the same hop to a second replica.

`BOT_HANDOFF_MAX_DEPTH` and `BOT_HANDOFF_MAX_PER_RUN` are the ceilings, and both refuse rather than
truncate. They are not polish: a hop is a whole agent turn at the other end, several Bots asked in one
turn cost several full runs, and where each Bot has its own computer a fan-out wakes a machine per
Bot. `BOT_HANDOFF_MAX_DEPTH=0` switches the capability off, and then no Bot is offered the tool and
the delivery loop does not run.

Every outcome is in the audit trail: offered, refused with which cap or missing grant stopped it,
delivered, failed, and retried. The refused row is the one that matters most, because a hop that
happened is visible in the transcript and one that was refused is invisible everywhere else.

## MCP and skills

MCP servers and skills share the plugin grant table, but they have different ownership rules.

- MCP tools are admin-governed because they can reach external systems with stored credentials.
- Skills are reusable instructions. A person can create personal skills and attach them only to Bots they own. Administrators create deployment skills.

The curated MCP catalogue contains Google Drive and Notion. Custom MCP servers must pass URL checks; unknown tools and custom-server tools are treated as writes unless positively classified as reads.

A catalogue entry says whose credential a Bot reaches it with, which is a different question from whether it is reachable at all. A deployment-wide token answers the same for everybody; Google Drive and Notion are both `user-oauth`, so a Bot reaches them as the person asking and sees only what that person can see. An administrator enabling the connector and a person connecting their own account are two decisions, and neither can be made for the other. See [Google Drive](plugins/google-drive.md) and [Notion](plugins/notion.md).

Every MCP call checks the grant first, then evaluates the same action policy engine with MCP context, then audits the result.

### Which tools a run is offered

A model picks the right tool reliably out of about ten, and unreliably out of thirty. A deployment that connects two vendors passes that point on its first afternoon, so a Bot holding more than a handful of tools is offered, per run, only the tools of the skills that match the message.

Skills come from two places: a person writes one, or the tenant package ships one in `skills.yaml`. Package skills are seeded on boot as deployment skills, carrying the tool refs they need, which is what lets narrowing work on a fresh clone instead of waiting for somebody to map tools to skills by hand. A slug a person already took stays theirs and the package loses that skill rather than the deployment refusing to start.

A skill declares the tools it needs (`skill_tools`). Before the run starts, the deployment asks its own model which skills the message needs, and the Bot is built with those skills' tools plus every granted tool no skill claims. A declaration grants nothing: the offer is always intersected with what the Bot was already granted, so writing a skill can never hand anybody a tool.

This narrows the offer. It is not a boundary, and it never substitutes for one. The grant, the policy and the audit row decide what may happen; this decides only what the model can see. Every way it can fail — no skills declared, a model that cannot answer, a message that matches nothing, twelve tools or fewer — leaves the whole catalogue offered, because a narrowing that failed closed would remove capability an administrator granted, silently. `mcp.tools_discovered` records what was offered, out of how much, and why.

## Tenant package and knowledge

`TENANT_PACKAGE_DIR` points at the tenant package. The default is `../examples/fintech`.

Required package files:

- `brand.yaml`
- `agents.yaml`
- `channels.yaml`
- `model.yaml`
- `knowledge.yaml`

The server validates the package at startup. Channel agent IDs must match declared agents. Knowledge sources currently support Google Drive and Microsoft OneDrive declarations.

Connector credentials are stored through the credential vault and referenced by id, not stored inline in YAML.

## Security boundaries

- Server routes enforce auth and roles; admin pages are backed by server-side administrator checks.
- Sign-in is Google, Microsoft or Okta from the environment, plus SAML and OpenID Connect providers registered at runtime and routed by email domain. One resolver answers both questions a run asks about a person, whose threads these are and which Bots they may run, so the two can never disagree.
- `INITIAL_ADMIN_EMAILS` is a floor: an address it names is made an administrator at every sign-in and cannot be demoted from the People screen. Everybody else's role is decided there, and every change writes an audit row.
- Registering, changing or removing an identity provider is administrator-only. Better Auth's SSO plugin guards those routes with a session alone, which would let any signed-in person register a provider for a domain.
- A registered identity provider belongs to the deployment, not to whoever registered it. Better Auth scopes its own listing and removal to the registering user and cascades the row from that user, so two administrators see two different deployments and deleting the one who set sign-in up deletes the company's sign-in. Reads and removals go through OpenBot's own administrator-only routes against the whole table.
- A provider's client secret and SAML signing material are encrypted at rest with `KEY_ENCRYPTION_KEY`, through a wrapper on the Better Auth storage adapter, since the plugin stores them as plaintext JSON. OAuth access and refresh tokens use Better Auth's own encryption, keyed on `BETTER_AUTH_SECRET`.
- Signing in, being refused, and being granted the administrator role by configuration each write an audit row. They are the only record that somebody who can edit `INITIAL_ADMIN_EMAILS` promoted themselves, and the only evidence a revoked person was ever here, since revoking them deletes their sessions.
- Removing somebody deletes their sessions and denies their address, because deleting the user row alone is not removal: the next sign-in through the provider recreates it.
- With no identity provider configured, the deployment refuses to start unless `OPENBOT_SINGLE_USER=true` says every request may be one fixed administrator. That flag is the only thing that permits it; `NODE_ENV` does not.
- `KEY_ENCRYPTION_KEY` must be a base64-encoded 32-byte value. The example key is refused with `NODE_ENV=production`.
- Credential plaintext is encrypted at rest, never returned by APIs, and redacted from audit events.
- Browser navigation allows `http` and `https`; cloud metadata addresses are refused under every configuration.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` is for local development only, and a deployment running with `NODE_ENV=production` refuses to start while it is set.
- Computer tokens and supervisor tokens must be long random values outside local development.
