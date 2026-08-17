# OpenBot

OpenBot is a workspace for AG-UI agents that operate a governed browser. Each Bot can use a live Chromium session, a workspace filesystem, CopilotKit Intelligence threads, MCP tools, skills, and governed UI components from one product surface.

> **Runs on your machine.** Everything below is written for a laptop. Out of the box OpenBot runs with `OPENBOT_DEV_NO_AUTH`, which skips signing in and admits every request as one administrator; [Google sign-in](#sign-in-with-google) can be wired up instead.

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
- Create a teammate from `/agents`, give it a standing role, and start a channel with it.

## Main surfaces

| Route                | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `/`                  | Start and browse channels.                                         |
| `/agents`            | Create, edit, duplicate, hide, delete, and launch teammates.       |
| `/channel/:id`       | Converse with one teammate and view its live screen/profile panel. |
| `/bot`               | Direct chat with a Bot; `?agent=<id>` selects one.                 |
| `/skills`            | Create and enable personal skills.                                 |
| `/settings`          | User preferences.                                                  |
| `/admin/connectors`  | Configure deployment knowledge sources.                            |
| `/admin/credentials` | Store write-only encrypted credentials.                            |
| `/admin/computers`   | View, stop, and reset Bot computers.                               |
| `/admin/boundaries`  | Configure browser/file/MCP action policy.                          |
| `/admin/components`  | Publish components and govern which Bots may use them.             |
| `/admin/playground`  | Draft and publish sandboxed components in the browser.             |
| `/admin/plugins`     | Configure MCP servers, MCP grants, and deployment skills.          |
| `/admin/audit`       | Review permitted, refused, and failed actions.                     |

## Bring your own agent

Any AG-UI endpoint can be a Bot.

From `/agents`, create a teammate with:

- name, title, and role description;
- private or public visibility;
- optional AG-UI endpoint;
- optional write-only authorization header.

The server validates agent endpoints with the same target checks used for browser navigation. If no custom endpoint is set, product-created teammates use `MANAGED_AGENT_AG_UI_URL`.

Tenant package agents are declared in `agents.yaml` as either:

- `built-in`, with a system prompt; or
- `remote-ag-ui`, with an endpoint.

See [docs/configuration.md](docs/configuration.md) and [docs/teammates.md](docs/teammates.md).

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
| `server`                 | 3001                       | Hono API, CopilotKit runtime, auth, policy, audit, plugins, components, teammates, and channels. |
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

## Components, MCP, and skills

- Compiled React components live in `app/src/components/gallery/` and register through the app.
- Sandboxed components are authored in `/admin/playground`, then published without a rebuild.
- Component use is checked at call time. A component must exist, be published, and not be withheld from the Bot.
- Component data functions are granted per component; the shipped functions read the audit trail.
- Curated MCP catalogue entries ship for Atlassian, Box, Slack, Salesforce, and ServiceNow.
- Custom MCP servers must pass URL checks and are treated fail-closed.
- Skills are instructions, not capabilities. Personal skills can be attached only to Bots the author owns; deployment skills are admin-owned.

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

- [docs/README.md](docs/README.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/development.md](docs/development.md)
- [docs/teammates.md](docs/teammates.md)

## Contributing

- Open an issue or coordinate before starting substantial work.
- Keep changes focused and update docs when setup, configuration, architecture, or user behavior changes.
- Keep secrets, service-account JSON, customer data, and local transcripts out of the repository.
- Run the checks in [Development](#development) before opening a pull request.

## License

[MIT](./LICENSE) © CopilotKit
