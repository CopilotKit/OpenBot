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

> **A template, not a product.** OpenBot is meant to be cloned and made your own. There is no hosted version to sign up for, and nothing here is published as a package to depend on: every workspace in this repository is private. You take the repository, replace the example tenant package under `examples/` with your own coworkers, channels and skills, and run it. Everything below describes a starting point, not a finished thing somebody operates for you.

> **Alpha, and under active development.** OpenBot is early. Expect rough edges and bugs, and expect things to move. Issues and pull requests are welcome.

> **Runs on your machine.** Everything below is written for a laptop. `.env.example` carries `OPENBOT_SINGLE_USER=true`, which admits every request as one administrator, so a fresh clone reaches the product without registering an OAuth client first. [Sign-in](#sign-in) turns that off, and is required before anybody else can reach the deployment.

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

- Docker, for PostgreSQL and the shipped Bots.
- [Bun](https://bun.sh) 1.3+, for the app and API server.
- A CopilotKit Intelligence project and license. A free plan is available, and Intelligence can be self-hosted.
- Either a model key, or the installed Codex CLI already authenticated with `codex login`. The proof-of-concept Bot uses OpenAI; the LangGraph Bot can use OpenAI, Anthropic, or Google; local Codex mode uses the ChatGPT account on this machine.

## Quick start

> **Setting up with an AI assistant?** Paste [`prompt.txt`](prompt.txt) into it first. It carries the
> same steps as below plus the things that are easy to get wrong: which of the ten blank keys in
> `.env.example` are actually yours to fill (three), which the start script generates for you, and
> what each start-up refusal means. Every claim in it is checked against this repository.

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

   Or, to use the ChatGPT account already signed in through Codex instead of a provider API key,
   set `CODEX_AGENT_ENABLED=true` and
   `AGENT_ENDPOINT_ALLOWED_HOSTS=localhost:4202`. See
   [agent-codex/README.md](agent-codex/README.md).

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

## Deploy it

One image carries the app, the API, the browser the Bots drive, and optionally PostgreSQL. Same
`.env`, no Kubernetes.

```sh
docker build -t openbot .
docker run -p 3001:3001 --env-file .env \
  -e EMBEDDED_POSTGRES=on -v openbot-data:/var/lib/postgresql openbot
```

Leave `EMBEDDED_POSTGRES` off and set `DATABASE_URL` to point at a database you already run.
[docs/deployment.md](docs/deployment.md) has the minimum sizes, the platform notes, and how it behaves behind more than one replica.

## Try it

- Open `/bot` and ask: `Open news.ycombinator.com and tell me the top story.`
- Ask the Bot to fill out <https://httpbin.org/forms/post>, then inspect `/admin/audit`.
- Open `/admin/boundaries`, add a deny rule or preset, and retry the same browser action.
- Create a coworker from `/agents`, give it a standing role, and start a channel with it.

## Main surfaces

| Route                | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `/`                  | Start and browse channels.                                         |
| `/agents`            | Create, edit, brand, duplicate, hide, delete, and launch coworkers. |
| `/channel/:id`       | Converse with one coworker, watch its screen, and see what it ran. |
| `/bot`               | Direct chat with a Bot; `?agent=<id>` selects one.                 |
| `/skills`            | Create and enable personal skills.                                 |
| `/settings`          | Personal profile, avatar, and user preferences.                    |
| `/admin/credentials` | Store write-only encrypted credentials.                            |
| `/admin/computers`   | View, stop, and reset Bot computers.                               |
| `/admin/boundaries`  | Configure browser/file/MCP action policy.                          |
| `/admin/components`  | Publish components and govern which Bots may use them.             |
| `/admin/playground`  | Draft and publish sandboxed components in the browser.             |
| `/admin/plugins`     | Configure MCP servers, MCP grants, and deployment skills.          |
| `/admin/audit`       | Review permitted, refused, and failed actions.                     |

## Features

- **A computer per Bot**: the supervisor gives each Bot its own container, its own `/workspace` volume and its own browser profile. The guarded screen shows the full Linux desktop, including browser chrome, dialogs and a terminal; its Browser and Terminal dock stays available when Chromium is closed. Set `COMPUTER_RUNTIME=runsc` to run them under gVisor where the host supports it.
- **A shell, not just a browser**: a Bot can run a command in its workspace, install what it needs, and process a file it saved. Through the same gate as everything else, so a rule can refuse a shell outright or refuse particular commands, and the command is on the record either way. The command inherits PATH, locale, terminal and proxy variables, not the rest of the deployment's environment.
- **The gateway is the only way in**: it resolves the target from a server-held snapshot, evaluates the policy, writes the audit row, and only then calls the computer. There is no path that acts without the record existing first.
- **CEL policy, fail closed**: rules can inspect `tool.name`, `intent`, `bot.id`, `actor.id`, `page.url`, `page.host`, `element.*`, `key`, `file.*` and `mcp.*`. Deny is evaluated before allow, a missing policy permits nothing, and a broken rule refuses rather than opens.
- **Watch what it is doing**: the screen shows what a Bot is looking at, and the Activity tab beside it shows what it ran, read and saved, with the output. A command line in the transcript opens to the same thing. A saved file shows its path and size, never its contents.
- **Take the wheel**: a Bot that hits a login wall or a 2FA prompt asks for help. Control is handed over in the same panel and recorded as `computer.help_requested`, `computer.control_taken` and `computer.control_released`. While a person is driving, Bot actions are refused rather than queued.
- **Secrets never enter the transcript**: the trail records that a secret was requested and how long it was, not what it said.
- **Bring your own agent**: any AG-UI endpoint is a Bot, on a framework or hand-written. Endpoints are validated with the same target checks used for browser navigation, and an auth header is stored write-only.
- **Use the Codex account already on your machine**: local Codex mode resumes persistent Codex threads and exposes only the tools OpenBot assigned. Calls return through the same grant, policy and audit gateway; Codex-native action surfaces are disabled before app-server turns begin.
- **Give people and Bots their own faces**: upload, replace, or remove PNG, JPEG, and WebP avatars from Settings or the coworker dialog. The same image follows that identity through the sidebar, channels, recipients, handoffs, and profile surfaces.
- **Components instead of prose**: compiled React components live in `app/src/components/gallery/`, sandboxed ones are authored in `/admin/playground` and published with no deployment. Every call asks the server whether the component exists, is published, and is not withheld from that Bot. Data functions are granted per component.
- **Governed MCP**: Google Drive and Notion ship in the catalogue, reached as the person asking. The catalogue carries only vendors this deployment stands behind, so adding one is a review of that vendor. Custom servers must pass URL checks; unknown tools and custom-server tools are treated as writes, and a catalogue tool the server advertises but does not name as a write classifies as a read. A Bot is told which connectors exist here and which it holds, so it says it has not been granted one rather than browsing to the vendor's website.
- **Skills are instructions, not capabilities**: personal skills attach only to Bots their author owns, deployment skills are admin-owned, and both are invoked with `/` in the composer.
- **Sign in with what your company already has**: Google, Microsoft or Okta from the environment, or a company's own SAML or OpenID Connect provider registered while the deployment runs and routed by email domain. Any one turns sign-in on; several may be configured at once.
- **Decide who gets in**: `/admin/people` lists everybody who has signed in, promotes and demotes them, and removes access, which ends the session they are using and stops the next sign-in. Every change is on the audit trail.
- **An audit trail you can read**: `/admin/audit` lists what was permitted, what was refused and what failed, and every refusal carries the rule that caused it.
- **Credentials encrypted at rest**: stored through `/admin/credentials`, never returned by an API, and redacted from audit events.
- **Loopback by default**: computers bind to `127.0.0.1` and require a per-container token, so nothing reaches a logged-in browser by knowing its port. The supervisor binds there too, because it holds the Docker socket and its token is a shared secret rather than a network boundary.
- **Durable threads and memory**: conversations survive restarts through CopilotKit Intelligence, and each deployment stamps the threads it owns.
- **Routines**: ask a Bot to do something on a schedule and it does, running as you, in the channel you asked in. A 15-minute floor and a cap of 20 enabled routines keep a sentence from scheduling more than a person meant, and ten failures in a row switch a routine off rather than burn model spend forever. Needs a worker process; see [docs/routines.md](docs/routines.md).

## Bring your own agent

Any AG-UI endpoint can be a Bot.

From `/agents`, create a coworker with:

- name, title, and role description;
- private or public visibility;
- optional AG-UI endpoint;
- optional write-only authorization header.

The server validates agent endpoints with the same target checks used for browser navigation, at registration and again on every redirect the endpoint answers with. If no custom endpoint is set, product-created coworkers use `MANAGED_AGENT_AG_UI_URL` when it is configured, and are refused when it is not.

A private address is refused unless it is listed in `AGENT_ENDPOINT_ALLOWED_HOSTS`:

```sh
AGENT_ENDPOINT_ALLOWED_HOSTS=agents.internal,10.0.0.42:9000
```

A host on its own covers any port on that host; a host with a port pins that port. Matching is exact: no wildcards, no suffixes. An entry written as a URL, or containing `*`, stops startup and names that entry.

The list covers agent endpoints only. Browsing is unaffected, the addresses holding a deployment's own cloud credentials are refused whatever is listed, and listing an address permits registering an agent there rather than granting that agent anything.

Tenant package agents are declared in `agents.yaml` as either:

- `built-in`, with a system prompt; or
- `remote-ag-ui`, with an endpoint.

See [docs/configuration.md](docs/configuration.md) and [docs/coworkers.md](docs/coworkers.md).

## Configuration

`.env.example` is the source template. The API server refuses to start without:

- `DATABASE_URL`
- `KEY_ENCRYPTION_KEY`
- `INTELLIGENCE_API_URL`
- `INTELLIGENCE_GATEWAY_WS_URL`
- `INTELLIGENCE_API_KEY`
- `COPILOTKIT_LICENSE_TOKEN`

Settings worth knowing:

| Variable                             | Use                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `OPENBOT_SINGLE_USER`                | Admits every request as one administrator. Required when no identity provider is configured; `.env.example` ships it on. |
| `OPENAI_BASE_URL`                    | Answers the OpenAI-shaped calls from somewhere else: a gateway, a proxy.  |
| `ANTHROPIC_BASE_URL`, `GOOGLE_GENERATIVE_AI_BASE_URL` | The same, for those two APIs.            |
| `COMPUTER_TOKEN`                     | Secret every Bot computer request must present. `start.sh` sets one.      |
| `SUPERVISOR_TOKEN`                   | Secret the supervisor requires. `start.sh` sets one.                      |
| `AGENT_TOOL_TOKEN`                   | Secret a Bot presents to call a granted tool back. `start.sh` sets one. Without it no Bot may call tools. |
| `CODEX_AGENT_ENABLED`                | Runs the host-side Codex adapter on port 4202 and skips the two provider-key Bot containers. |
| `COMPUTER_SUPERVISOR_URL`            | Gives each Bot a computer of its own instead of one shared computer.      |
| `COMPUTER_RUNTIME`                   | Set to `runsc` to run computers under gVisor, where the host has it.      |
| `COMPUTER_SANDBOX`                   | Set to `on` for Chromium's own sandbox, where the host permits it.        |
| `EMBEDDED_POSTGRES`                  | Set to `on` for a database inside the deployment container.               |
| `AGENT_COMPUTER_POLICY`              | JSON action policy. Malformed JSON stops server startup.                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Lets a Bot reach this machine's own services. Local only, and refused under `NODE_ENV=production`. |
| `AGENT_ENDPOINT_ALLOWED_HOSTS`       | Private addresses an agent may be registered at, comma separated. A host, optionally with a port. |
| `TENANT_PACKAGE_DIR`                 | Directory containing tenant YAML. Defaults to `../examples/fintech`.      |
| `DEPLOYMENT_ID`                      | Names this deployment when two share one Intelligence project.            |

Full reference: [docs/configuration.md](docs/configuration.md).

## Architecture

| Service                  | Port                       | Purpose                                                                                          |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `app`                    | 3010                       | React/Vite UI.                                                                                   |
| `server`                 | 3001                       | Hono API, CopilotKit runtime, auth, policy, audit, plugins, components, coworkers, and channels. |
| `agent-computer`         | 4100                       | Linux desktop, Chromium, terminal, `/workspace`, and browser profile.                            |
| `agent-bot`              | 4200                       | Proof-of-concept AG-UI Bot.                                                                          |
| `agent-langgraph`        | 4201                       | LangGraph AG-UI Bot.                                                                             |
| `agent-codex`            | 4202                       | Optional host-side Codex AG-UI adapter using the local ChatGPT login.                            |
| `supervisor`             | 4500 host / 4300 container | Creates and manages one computer per Bot.                                                        |
| PostgreSQL with pgvector | 5432                       | Product data, policy, audit, credentials, grants, channels, and component metadata.              |
| CopilotKit Intelligence  | external                   | Durable threads and memory.                                                                      |

The server gateway is the product/API path for Bot browser and file tool calls.
It resolves the target, evaluates policy, writes an audit row, and then calls
`agent-computer`. The computer also exposes lower-level token-protected service
endpoints; keep them private and do not use them to bypass the gateway.

More detail: [docs/architecture.md](docs/architecture.md).

## Sign in

`.env.example` ships `OPENBOT_SINGLE_USER=true`, which is one administrator and no sign-in: how a
fresh clone reaches the product without registering an OAuth client first. Delete that line and
configure **any one** of Google, Microsoft or Okta before anybody else can reach the deployment.
With neither, it refuses to start rather than admitting everybody as an administrator. Configure
more than one provider and the sign-in screen offers each of them.

These four are needed whichever you pick:

```sh
BETTER_AUTH_URL=http://localhost:3001        # where OAuth callbacks come back to
BETTER_AUTH_SECRET=                          # openssl rand -base64 32
TRUSTED_ORIGINS=http://localhost:3010        # where the app is served from
INITIAL_ADMIN_EMAILS=you@example.com         # comma separated
```

Then the provider. Register the redirect URI shown beside it.

```sh
# Google — http://localhost:3001/api/auth/callback/google
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# Microsoft — http://localhost:3001/api/auth/callback/microsoft
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_TENANT_ID=common             # your directory GUID for staff only

# Okta — http://localhost:3001/api/auth/callback/okta
OKTA_OAUTH_CLIENT_ID=
OKTA_OAUTH_CLIENT_SECRET=
OKTA_OAUTH_ISSUER=https://example.okta.com/oauth2/default
```

Restart. Accounts, sessions and roles are stored in the same PostgreSQL database as everything else.

A company's own SAML or OpenID Connect provider is registered while the deployment runs, under
Admin → Identity providers, and routed by email domain. An OIDC registration needs every host in the
provider's discovery document listed in `TRUSTED_ORIGINS`, not only the issuer.

- `INITIAL_ADMIN_EMAILS` is required, because nothing else grants the administrator role and no
  screen can promote somebody afterwards. It is re-read on every sign-in, so editing it takes effect
  the next time that person signs in.
- `MICROSOFT_OAUTH_TENANT_ID` defaults to `common`, which admits personal Microsoft accounts as well
  as work ones. On a multi-tenant app registration Entra may send no `email` claim at all, so
  OpenBot falls back to `upn` and then `preferred_username`. If none of the three arrives the
  sign-in is refused and the reason is logged: add `email` as an optional claim, or use your
  directory GUID here.
- A half-configured provider is refused at start-up rather than at somebody's first attempt to sign
  in: a client id with no secret, a secret shorter than 32 characters, or an Okta issuer with no
  credentials behind it.
- **SAML and OIDC** are registered while the deployment runs rather than configured here. Sign in as
  an administrator and go to Admin → Identity providers with the metadata your identity team gave
  you. People then sign in by typing their email address, and the domain decides which provider
  they are sent to.
- **Put TLS in front of any deployment.** A page served over plain `http://` on anything but
  localhost is not a secure context, and sign-in cookies want `Secure`.

## Keeping it to your machine

- `agent-computer` drives a browser holding real logins. `docker-compose.yml` binds it to loopback; leave it there.
- Store credentials through `/admin/credentials`, which encrypts them. Do not put credential values in tenant YAML or in committed files.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` lets a Bot reach services on this machine. It ships commented out in `.env.example`, is for a laptop only, and a deployment running with `NODE_ENV=production` refuses to start while it is set.
- To reach an agent on your own network from a deployment, list its address in `AGENT_ENDPOINT_ALLOWED_HOSTS` instead. That permits the one address, where the switch above permits the network.

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
- [docs/deployment.md](docs/deployment.md)
- [docs/releasing.md](docs/releasing.md)

## Contributing

- Open an issue or coordinate before starting substantial work.
- Keep changes focused and update docs when setup, configuration, architecture, or user behavior changes.
- Keep secrets, service-account JSON, customer data, and local transcripts out of the repository.
- Run the checks in [Development](#development) before opening a pull request.

## License

[MIT](./LICENSE) © CopilotKit
