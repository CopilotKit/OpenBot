<div align="center">

# OpenBot

**AI coworkers you can hand real work to, and actually trust with the access.** Each gets a computer of its own: a real browser with its own logins, its own files, and only the tools you grant. Every action decided before it happens and recorded after.

[**copilotkit.ai/openbot**](https://copilotkit.ai/openbot) · [**Quick start**](#quick-start) · [**Features**](#features) · [**Bring your own agent**](#bring-your-own-agent) · [**Architecture**](#architecture) · [**Docs**](docs/README.md)

[![CI](https://github.com/CopilotKit/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/CopilotKit/openbot/actions/workflows/ci.yml)
[![security](https://github.com/CopilotKit/openbot/actions/workflows/security_zizmor.yml/badge.svg)](https://github.com/CopilotKit/openbot/actions/workflows/security_zizmor.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Alpha](https://img.shields.io/badge/status-alpha-orange.svg)

</div>

https://github.com/user-attachments/assets/535ef7ee-1631-4a69-b839-564c56cf90b4

<div align="center">

Bring any AG-UI agent, written on a framework or by hand, and it arrives as a
coworker with a channel of its own. Watch it work on its own screen, take the
wheel when it reaches something it should not do alone, then hand it back. It
answers with components rather than only prose, and the whole thing runs on
your own machine.

</div>

> **Alpha, and under active development.** OpenBot is early. Expect rough edges and bugs, and expect things to move. Issues and pull requests are welcome.

> **Runs on your machine.** Everything below is written for a laptop. Out of the box OpenBot runs with `OPENBOT_DEV_NO_AUTH`, which skips signing in and admits every request as one administrator. [Google sign-in](#sign-in-with-google) can be wired up instead.

## What it is

An agent platform that runs inside your own infrastructure. Docker Compose brings up every part of it, the data sits in your PostgreSQL, and the model is yours to choose: no model ships in the box, and an administrator supplies the credential, which is encrypted at rest and never logged.

Three coworkers ship in the example package, and they are configuration rather than code: **General Assistant** for everyday work, **Knowledge** for company questions, **Risk Analyst** for risk and compliance. Add your own by editing `agents.yaml` or from `/agents` in the UI.

Anything a Bot does to a computer, a file, an MCP server or a component goes through one gateway that decides and records it. That is the difference between an agent that can use your tools and an agent you can let near them.

More at [copilotkit.ai/openbot](https://copilotkit.ai/openbot).

## Built on AG-UI

A Bot is any endpoint speaking [AG-UI](https://github.com/ag-ui-protocol/ag-ui), the open protocol for agent-to-user interaction, so OpenBot is not tied to a framework and neither are you. Agents built with LangGraph, Mastra, CrewAI, Pydantic AI, Google ADK or written by hand all arrive the same way, and the governance rides the protocol rather than the framework.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img src="assets/architecture-light.svg" alt="You talk to the server, which sends the turn to a Bot over AG-UI. Every tool call the Bot makes comes back through the gateway, which resolves the target, decides it against your policy, records an audit row, and only then acts, or refuses and names the rule. Allowed browser and file actions reach that Bot's own computer, one container each with its own Chromium, logins and workspace, built by the supervisor. Decisions land in PostgreSQL and threads in CopilotKit Intelligence.">
</picture>

## Requirements

- Docker, for PostgreSQL, browser computers, the supervisor, and the shipped Bots.
- [Bun](https://bun.sh) 1.3+, for the app and API server.
- A CopilotKit Intelligence project and license.
- A model key. The proof-of-concept Bot uses OpenAI; the LangGraph Bot can use OpenAI, Anthropic, or Google.

## Quick start

1. Create `.env`:

   ```sh
   cp .env.example .env
   ```

2. Get CopilotKit Intelligence credentials:

   ```sh
   npx --yes copilotkit@latest login
   npx --yes copilotkit@latest project select
   npx --yes copilotkit@latest license --write
   ```

   Put the `cpk-...` runtime key from `project select` in `.env` as
   `INTELLIGENCE_API_KEY`. `license --write` writes
   `COPILOTKIT_LICENSE_TOKEN` into the existing `.env`.

3. Fill the remaining required values:

   - `OPENAI_API_KEY`

   Keep the managed Intelligence URLs from `.env.example` unless you run Intelligence yourself. The example `KEY_ENCRYPTION_KEY` is public and fine locally; generate your own with:

   ```sh
   openssl rand -base64 32
   ```

4. Install and run:

   ```sh
   bun install
   bash scripts/start.sh
   ```

5. Open <http://localhost:3010>.

`scripts/start.sh` starts Docker services, applies migrations, starts the API server on port 3001, starts the app on port 3010, and checks that the services answer their own health routes before printing next steps.

## Try it

- Open `/bot` and ask: `Open news.ycombinator.com and tell me the top story.`
- Ask the Bot to fill out <https://httpbin.org/forms/post>, then inspect `/admin/audit`.
- Open `/admin/boundaries`, add a deny rule or preset, and retry the same browser action.
- Create a coworker from `/agents`, give it a standing role, and start a channel with it.

## Main surfaces

| Route                | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `/`                  | Start and browse channels.                                         |
| `/agents`            | Create, edit, duplicate, hide, delete, and launch coworkers.       |
| `/channel/:id`       | Converse with one coworker and view its live screen/profile panel. |
| `/bot`               | Direct chat with a Bot; `?agent=<id>` selects one.                 |
| `/skills`            | Create and enable personal skills.                                 |
| `/routines`          | Schedule unattended work, run one now, and read its run history.   |
| `/settings`          | User preferences.                                                  |
| `/admin/connectors`  | Configure deployment knowledge sources.                            |
| `/admin/credentials` | Store write-only encrypted credentials.                            |
| `/admin/computers`   | View, stop, and reset Bot computers.                               |
| `/admin/boundaries`  | Configure browser/file/MCP action policy.                          |
| `/admin/components`  | Publish components and govern which Bots may use them.             |
| `/admin/playground`  | Draft and publish sandboxed components in the browser.             |
| `/admin/plugins`     | Configure MCP servers, MCP grants, and deployment skills.          |
| `/admin/webhooks`    | Create webhook triggers, confirm a first delivery, rotate secrets. |
| `/admin/audit`       | Review permitted, refused, and failed actions.                     |

## Features

- **A computer per Bot**: the supervisor gives each Bot its own container, its own `/workspace` volume and its own browser profile. Set `COMPUTER_RUNTIME=runsc` to run them under gVisor where the host supports it.
- **The gateway is the only way in**: it resolves the target from a server-held snapshot, evaluates the policy, writes the audit row, and only then calls the computer. There is no path that acts without the record existing first.
- **CEL policy, fail closed**: rules can inspect `tool.name`, `intent`, `bot.id`, `actor.id`, `page.url`, `page.host`, `element.*`, `key`, `file.*` and `mcp.*`. Deny is evaluated before allow, a missing policy permits nothing, and a broken rule refuses rather than opens.
- **Take the wheel**: a Bot that hits a login wall or a 2FA prompt asks for help. Control is handed over in the same panel and recorded as `computer.help_requested`, `computer.control_taken` and `computer.control_released`. While a person is driving, Bot actions are refused rather than queued.
- **Secrets never enter the transcript**: the trail records that a secret was requested and how long it was, not what it said.
- **Bring your own agent**: any AG-UI endpoint is a Bot, on a framework or hand written. Endpoints are validated with the same target checks used for browser navigation, and an auth header is stored write-only.
- **Components instead of prose**: compiled React components live in `app/src/components/gallery/`, sandboxed ones are authored in `/admin/playground` and published with no deployment. Every call asks the server whether the component exists, is published, and is not withheld from that Bot. Data functions are granted per component.
- **Governed MCP**: a curated catalogue ships for Atlassian, Box, Slack, Salesforce and ServiceNow. Custom servers must pass URL checks, and any tool not positively classified as a read is treated as a write.
- **Skills are instructions, not capabilities**: personal skills attach only to Bots their author owns, deployment skills are admin-owned, and both are invoked with `/` in the composer.
- **Routines run unattended, through the same gateway**: a scheduled run drives the Bot server side with no browser in the loop, and every tool call still goes through the gateway, so the same policy decides it and the same audit row records it. A window the deployment slept through is recorded as `missed` rather than fired late. `run.unattended` is a policy attribute, so a deployment can write `run.unattended && intent == "activate"` to let a routine read and never press.
- **Webhook triggers on their own port**: deliveries arrive on `ROUTINE_WEBHOOK_PORT` (default `PORT + 1`), which serves `/health` and `/hooks/:endpointId` and nothing else. A bearer secret is stored only as a hash and compared in constant time, and a new trigger keeps its first authenticated delivery as a sample and runs nothing until a person has looked at it.
- **An audit trail you can read**: `/admin/audit` lists what was permitted, what was refused and what failed, and every refusal carries the rule that caused it.
- **Credentials encrypted at rest**: stored through `/admin/credentials`, never returned by an API, and redacted from audit events.
- **Loopback by default**: computers bind to `127.0.0.1` and require a per-container token, so nothing reaches a logged-in browser by knowing its port.
- **Durable threads and memory**: conversations survive restarts through CopilotKit Intelligence, and each deployment stamps the threads it owns.

## Bring your own agent

Any AG-UI endpoint can be a Bot.

From `/agents`, create a coworker with:

- name, title, and role description;
- private or public visibility;
- optional AG-UI endpoint;
- optional write-only authorization header.

The server validates agent endpoints with the same target checks used for browser navigation. If no custom endpoint is set, product-created coworkers use `MANAGED_AGENT_AG_UI_URL`.

Tenant package agents are declared in `agents.yaml` as either:

- `built-in`, with a system prompt; or
- `remote-ag-ui`, with an endpoint.

See [docs/configuration.md](docs/configuration.md) and [docs/coworkers.md](docs/coworkers.md).

## Configuration

`.env.example` is the source template. The API server refuses to start without:

- `DATABASE_URL`
- `KEY_ENCRYPTION_KEY`
- `MANAGED_AGENT_AG_UI_URL`
- `INTELLIGENCE_API_URL`
- `INTELLIGENCE_GATEWAY_WS_URL`
- `INTELLIGENCE_API_KEY`
- `COPILOTKIT_LICENSE_TOKEN`

Settings worth knowing:

| Variable                             | Use                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `OPENBOT_DEV_NO_AUTH`                | Admits every request as one administrator. How OpenBot runs today.        |
| `COMPUTER_TOKEN`                     | Secret every Bot computer request must present. `start.sh` sets one.      |
| `SUPERVISOR_TOKEN`                   | Secret the supervisor requires. `start.sh` sets one.                      |
| `COMPUTER_SUPERVISOR_URL`            | Gives each Bot a computer of its own instead of one shared computer.      |
| `COMPUTER_RUNTIME`                   | Set to `runsc` to run computers under gVisor, where the host has it.      |
| `AGENT_COMPUTER_POLICY`              | JSON action policy. Malformed JSON stops server startup.                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Lets a Bot reach this machine's own services.                             |
| `TENANT_PACKAGE_DIR`                 | Directory containing tenant YAML. Defaults to `../examples/fintech`.      |
| `DEPLOYMENT_ID`                      | Names this deployment when two share one Intelligence project.            |

Full reference: [docs/configuration.md](docs/configuration.md).

## Architecture

| Service                  | Port                       | Purpose                                                                                          |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `app`                    | 3010                       | React/Vite UI.                                                                                   |
| `server`                 | 3001                       | Hono API, CopilotKit runtime, auth, policy, audit, plugins, components, coworkers, and channels. |
| `agent-computer`         | 4100                       | Chromium plus `/workspace` and browser profile.                                                  |
| `agent-bot`              | 4200                       | Proof-of-concept AG-UI Bot.                                                                          |
| `agent-langgraph`        | 4201                       | LangGraph AG-UI Bot.                                                                             |
| `supervisor`             | 4500 host / 4300 container | Creates and manages one computer per Bot.                                                        |
| PostgreSQL with pgvector | 5432                       | Product data, policy, audit, credentials, grants, channels, knowledge, and component metadata.   |
| CopilotKit Intelligence  | external                   | Durable threads and memory.                                                                      |

The server gateway is the product/API path for Bot browser and file tool calls.
It resolves the target, evaluates policy, writes an audit row, and then calls
`agent-computer`. The computer also exposes lower-level token-protected service
endpoints; keep them private and do not use them to bypass the gateway.

More detail: [docs/architecture.md](docs/architecture.md).

## Sign in with Google

`OPENBOT_DEV_NO_AUTH` is the default because it needs no OAuth credentials and no consent screen. To sign in for real instead, create a Google OAuth client and set all four of these together:

```sh
BETTER_AUTH_URL=http://localhost:3001
BETTER_AUTH_SECRET=        # openssl rand -base64 32, at least 32 characters
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

Then set the two that decide who gets in and from where:

- `TRUSTED_ORIGINS` — where the app is served from, `http://localhost:3010` locally. It defaults to `http://localhost:3000`, which is not where `start.sh` serves the app.
- `INITIAL_ADMIN_EMAILS` — comma separated. An address listed here becomes an administrator the first time it signs in; everybody else becomes a user.

Remove `OPENBOT_DEV_NO_AUTH`, then restart: the sign-in button is written into the app's generated config at startup, so it appears only once all four settings are present. Accounts, sessions and roles are stored in the same PostgreSQL database as everything else.

A partial set is refused rather than ignored: the server will not start with `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL` but no client credentials, or with a secret shorter than 32 characters.

## Keeping it to your machine

- `agent-computer` drives a browser holding real logins. `docker-compose.yml` binds it to loopback; leave it there.
- Store credentials through `/admin/credentials`, which encrypts them. Do not put credential values in tenant YAML or in committed files.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` lets a Bot reach services on this machine. Unset it if you would rather it could not.

## Development

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Use `bash scripts/start.sh` for the whole stack. Use `bun run dev` only when you want the app and server without the Docker Bots and computers.

## Documentation

- [copilotkit.ai/openbot](https://copilotkit.ai/openbot)
- [docs/README.md](docs/README.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/development.md](docs/development.md)
- [docs/coworkers.md](docs/coworkers.md)

## Contributing

- Open an issue or coordinate before starting substantial work.
- Keep changes focused and update docs when setup, configuration, architecture, or user behavior changes.
- Keep secrets, service-account JSON, customer data, and local transcripts out of the repository.
- Run the checks in [Development](#development) before opening a pull request.

## License

[MIT](./LICENSE) © CopilotKit
