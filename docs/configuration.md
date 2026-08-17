# Configuration

OpenBot is configured with environment variables and a tenant package. The API server validates both at startup.

## Environment setup

```sh
cp .env.example .env
```

Fill the required values, then run:

```sh
bash scripts/start.sh
```

## Required API server variables

| Variable                      | Meaning                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string.                                                                         |
| `KEY_ENCRYPTION_KEY`          | Base64-encoded 32-byte key for encrypted stored credentials. Generate with `openssl rand -base64 32`. |
| `MANAGED_AGENT_AG_UI_URL`     | Default AG-UI endpoint for teammates created in the product. Must be HTTP(S).                         |
| `INTELLIGENCE_API_URL`        | CopilotKit Intelligence API URL.                                                                      |
| `INTELLIGENCE_GATEWAY_WS_URL` | CopilotKit Intelligence realtime gateway URL.                                                         |
| `INTELLIGENCE_API_KEY`        | Runtime key for the Intelligence project.                                                             |
| `COPILOTKIT_LICENSE_TOKEN`    | License token for the Intelligence project.                                                           |

All four Intelligence values are required together. Missing any of them stops server startup.

## General variables

| Variable             | Default                            | Meaning                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `PORT`               | `3001`                             | API server port.                                                    |
| `NODE_ENV`           | unset                              | `production` enables startup refusals for local-only settings.      |
| `TENANT_PACKAGE_DIR` | `../examples/fintech`              | Tenant package directory, resolved from `server/`.                  |
| `DEPLOYMENT_ID`      | the tenant package's id            | Names this deployment inside a shared Intelligence project.          |
| `OPENAI_API_KEY`     | unset                              | Default model key for built-in agents and both shipped Bots.        |
| `BOT_PROVIDER`       | `openai`                           | Provider for `agent-langgraph`: `openai`, `anthropic`, or `google`. |
| `ANTHROPIC_API_KEY`  | unset                              | Anthropic key when `BOT_PROVIDER=anthropic`.                        |
| `GOOGLE_API_KEY`     | unset                              | Google key when `BOT_PROVIDER=google`.                              |
| `BOT_MODEL`          | provider default from Bot code/env | Model used by the shipped Bots.                                     |
| `BOT_RESPONSES_API`  | `false`                            | Makes `agent-langgraph` use the OpenAI Responses API.               |

## Authentication

| Variable                     | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `OPENBOT_DEV_NO_AUTH`        | Local-only fixed administrator when set to `true`. Refused with `NODE_ENV=production`. |
| `GOOGLE_OAUTH_CLIENT_ID`     | Google OAuth client id.                                                                |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret.                                                            |
| `BETTER_AUTH_SECRET`         | At least 32 characters. Required with Google OAuth.                                    |
| `BETTER_AUTH_URL`            | Public API server base URL. Required with Google OAuth.                                |
| `TRUSTED_ORIGINS`            | Comma-separated app origins accepted by the API.                                       |
| `INITIAL_ADMIN_EMAILS`       | Comma-separated users seeded as administrators.                                        |

Google OAuth client id and secret must be configured together. If Google OAuth is configured, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are also required.

## Computer and supervisor

| Variable                             | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AGENT_COMPUTER_URL`                 | Shared computer URL. If absent, computer routes are not mounted.                          |
| `COMPUTER_TOKEN`                     | Secret every computer request must present. The computer refuses to start without it.     |
| `COMPUTER_SUPERVISOR_URL`            | Supervisor URL for per-Bot computers. If absent, Bots share `AGENT_COMPUTER_URL`.         |
| `SUPERVISOR_TOKEN`                   | Bearer token required by the supervisor.                                                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local-only private-host browsing when `true`. Cloud metadata addresses are still refused. |
| `AGENT_COMPUTER_POLICY`              | JSON action policy: `{"mode":"enforce","deny":[...],"allow":[...]}`.                      |
| `COMPUTER_RUNTIME`                   | Set to `runsc` to run supervised computers under gVisor.                                  |

`agent-computer` also reads:

- `ACTION_TIMEOUT_MS`
- `NAVIGATION_TIMEOUT_MS`
- `WORKSPACE_DIR`
- `PROFILES_DIR`
- `COMPUTER_BOT_ID`
- `EGRESS_PROXY_DEFAULT`
- `EGRESS_PROXY_<BOT_ID>`

The supervisor also reads:

- `COMPUTER_IMAGE`
- `COMPUTER_NAMESPACE`
- `COMPUTER_NETWORK`
- `COMPUTER_MEMORY_BYTES`
- `DOCKER_SOCKET`

`COMPUTER_NAMESPACE` defaults to `openbot` and names the deployment a computer belongs to. It is part
of every container and volume name the supervisor derives, and the supervisor acts only on computers
carrying it, so two deployments on one Docker host never adopt each other's.

Per-Bot computers belong to the supervisor rather than to Compose, so `docker compose down -v` does
not remove them: their containers keep running and their profile volumes, which hold whatever the
Bots are signed in to, survive. Remove them by the label the supervisor sets:

```sh
docker ps -aq --filter "label=openbot.namespace=openbot" | xargs -r docker rm -f
docker volume ls -q --filter "label=openbot.namespace=openbot" | xargs -r docker volume rm
```

Proxy credentials may appear in proxy URLs, but the computer strips them before reporting proxy status.

## Attested identity

When optional SPIRE services are used:

- the supervisor reads `SPIRE_SOCKET`, `SPIRE_AGENT_ID`, `SPIRE_TRUST_DOMAIN`, and `SPIRE_AGENT_SOCKET_VOLUME`;
- computers read `SPIFFE_ENDPOINT_SOCKET`;
- Compose also uses `SPIRE_JOIN_TOKEN` and `COMPOSE_PROJECT_NAME`.

## Ports

| Service           | Default port               | Setting           |
| ----------------- | -------------------------- | ----------------- |
| `app`             | 3010                       | `APP_PORT`        |
| `server`          | 3001                       | `SERVER_PORT`     |
| `agent-computer`  | 4100                       | `COMPUTER_PORT`   |
| `agent-bot`       | 4200                       | `BOT_PORT`        |
| `agent-langgraph` | 4201                       | `LANGGRAPH_PORT`  |
| `supervisor`      | 4500 host / 4300 container | `SUPERVISOR_PORT` |
| PostgreSQL        | 5432                       | `POSTGRES_PORT`   |

Set these in `.env` or in the environment. `docker-compose.yml` publishes on them and
`scripts/start.sh` reads the same names to decide where to look, so one setting moves a service and
everything that talks to it. The addresses built from them are separate settings, so a moved service
also needs its URL changed: `DATABASE_URL`, `AGENT_COMPUTER_URL` and `MANAGED_AGENT_AG_UI_URL`.

To run two deployments on one Docker host, give the second one its own `COMPOSE_PROJECT_NAME`,
`COMPUTER_NAMESPACE` and `COMPUTER_IMAGE`. Container and volume names are global to a host, and the
namespace is what keeps each deployment's per-Bot computers its own.

Give it its own `DEPLOYMENT_ID` as well when it shares an Intelligence project, which a copy made
from the same `.env` does. Threads are listed per Bot and carry nothing else that says where a
conversation came from, so the name goes into every thread id a deployment mints and is how its own
conversations stay tellable from the other's.

Set `OPENBOT_ONE_COMPUTER_EACH=false` when using `start.sh` to run all Bots against one shared computer.

## Tenant package

The tenant package contains five required YAML files:

```text
examples/fintech/
├── brand.yaml
├── agents.yaml
├── channels.yaml
├── model.yaml
└── knowledge.yaml
```

### `brand.yaml`

```yaml
tenant:
  id: openbot
  product_name: OpenBot
```

Optional theme:

```yaml
skin:
  stylesheet: theme.css
```

Theme CSS may define only `:root` and `.dark` blocks, approved theme variables, and no `@import` or `url()`.

### `agents.yaml`

```yaml
agents:
  - id: knowledge
    name: Knowledge
    title: Company Knowledge
    role_description: Answer company knowledge questions and cite sources.
    avatar_seed: knowledge
    type: built-in
    system_prompt: Answer from authorized company knowledge and cite every source.

  - id: risk-analyst
    name: Risk Analyst
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: ${MANAGED_AGENT_AG_UI_URL}
```

Each agent requires `id`, `name`, `title`, `role_description`, and `type`.

| Type           | Required field  |
| -------------- | --------------- |
| `built-in`     | `system_prompt` |
| `remote-ag-ui` | `endpoint`      |

Any `${NAME}` in a package file is replaced with that environment variable, so one package works
against a local stack, a staging one and production. `${NAME:-fallback}` uses the fallback when the
name is unset or empty, which is how the example package points at the Bot in the box without
requiring any configuration. A name with neither a value nor a fallback stops the server with a
message saying which file wanted it, rather than leaving a Bot pointed at an address nobody meant.

### `channels.yaml`

```yaml
channels:
  - id: risk-and-compliance
    name: Risk & Compliance
    description: Investigate policies and controls.
    permitted_agents: [knowledge, risk-analyst]
    allowed_groups: [risk, compliance]
```

Each channel requires `id`, `name`, `description`, `permitted_agents`, and `allowed_groups`. Every `permitted_agents` entry must match an agent id.

### `model.yaml`

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: gpt-4.1
```

`provider` must be `openai`. `credential_secret_ref` is a reference to a stored credential, not a credential value.

### `knowledge.yaml`

```yaml
sources:
  - type: google-drive
    roots: [Policies, Compliance]
  - type: microsoft-onedrive
    roots: [Risk, Operations]
```

Supported source types are `google-drive` and `microsoft-onedrive`.

## Change workflow

1. Edit the relevant `.env` value or tenant YAML file.
2. Check cross-file references, especially `channels[].permitted_agents`.
3. Keep credential values and service-account JSON out of YAML.
4. Restart the API server; invalid configuration stops startup.
5. Run:

   ```sh
   bun run format:check
   bun run lint
   bun run typecheck
   bun run test
   ```
