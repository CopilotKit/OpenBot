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
| `INTELLIGENCE_API_URL`        | CopilotKit Intelligence API URL.                                                                      |
| `INTELLIGENCE_GATEWAY_WS_URL` | CopilotKit Intelligence realtime gateway URL.                                                         |
| `INTELLIGENCE_API_KEY`        | Runtime key for the Intelligence project.                                                             |
| `COPILOTKIT_LICENSE_TOKEN`    | License token for the Intelligence project.                                                           |

All four Intelligence values are required together. Missing any of them stops server startup.

`MANAGED_AGENT_AG_UI_URL` names the Bot in the box: the default endpoint for coworkers created in
the product. It needs `MANAGED_AGENT_TOKEN` beside it, or the server refuses to start. Unset, the
server starts without a managed Bot, the shipped Risk Analyst coworker is omitted, and creating a
coworker without its own endpoint is refused. A leftover token with no URL is ignored. The
one-container image has no Bot process, so leave the URL unset there. `scripts/start.sh` normally
points it at `agent-langgraph` on a laptop, or at `agent-codex` when local Codex mode is enabled.

## General variables

| Variable             | Default                            | Meaning                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `PORT`               | `3001`                             | API server port.                                                    |
| `NODE_ENV`           | unset                              | `production` refuses the example `KEY_ENCRYPTION_KEY`. It does not decide whether sign-in is required; see `OPENBOT_SINGLE_USER`. |
| `TENANT_PACKAGE_DIR` | `../examples/fintech`              | Tenant package directory, resolved from `server/`.                  |
| `DEPLOYMENT_ID`      | the tenant package's id            | Names this deployment inside a shared Intelligence project.          |
| `OPENAI_API_KEY`     | unset                              | Default model key for built-in agents and both provider-key Bots. Not needed for local Codex mode. |
| `OPENAI_BASE_URL`    | unset                              | OpenAI-compatible endpoint that key is spent against. See below.    |
| `BOT_PROVIDER`       | `openai`                           | Provider for `agent-langgraph`: `openai`, `anthropic`, or `google`. |
| `ANTHROPIC_API_KEY`  | unset                              | Anthropic key when `BOT_PROVIDER=anthropic`.                        |
| `ANTHROPIC_BASE_URL` | unset                              | Anthropic-compatible endpoint that key is spent against.            |
| `GOOGLE_API_KEY`     | unset                              | Google key when `BOT_PROVIDER=google`.                              |
| `GOOGLE_GENERATIVE_AI_BASE_URL` | unset                   | Google-compatible endpoint that key is spent against.               |
| `BOT_MODEL`          | provider default from Bot code/env | Model used by the shipped Bots.                                     |
| `BOT_RESPONSES_API`  | `false`                            | Makes `agent-langgraph` use the OpenAI Responses API.               |
| `AGENT_STALL_TIMEOUT_MS` | unset (off)                    | How long a Bot's stream may produce nothing before the turn is ended for it. |
| `AGENT_TOOL_TOKEN`   | unset; `start.sh` generates one    | The secret a framework Bot presents when it calls a granted tool back through this server. |
| `APP_DIST_DIR`       | unset                              | Where the built app is, when this process serves it. Set inside the container image; unset in development, where Vite serves the app. |
| `AUDIT_RETENTION_DAYS` | unset                            | Whole number of days to keep audit rows; older ones are removed. Unset keeps the trail forever. |
| `WORKER_SHARED_SECRET` | unset; `start.sh` uses a fixed local default | The secret the routines worker presents to fire a due routine. Without it the server refuses every handoff, whether or not a worker exists to send one. |
| `OPENBOT_GENERATIVE_UI` | unset (capability off)              | `true` or `1` lets a Bot answer with an interface it wrote itself. |

**`OPENBOT_GENERATIVE_UI`** turns on generated interfaces. Set it, and a Bot may answer by writing
the markup, styles and script for an interface and streaming it into the transcript, where it renders
in a sandboxed iframe. Left unset, a Bot answers in prose and with the components this deployment
holds, as before.

It is asked for rather than inherited, which is deliberate and unlike most switches here. This one
decides whether a model may put code it wrote on somebody's screen and load libraries from a CDN to
run it, so a deployment should choose it rather than acquire it by upgrading — including a deployment
that builds its default branch automatically. Only `true` or `1` count as yes; anything else leaves it
off.

This is not the component catalogue. A component is something the deployment holds — compiled into
the build or authored in the playground — and an administrator grants it per Bot. A generated
interface has nothing to grant: it does not exist until the Bot writes it, and it is gone when the
conversation moves on. That is also why this is one switch for the deployment rather than a grant per
Bot. The interface is painted from activity events that only the runtime middleware emits, and the
tool the model calls is registered by the browser for every Bot the moment that middleware runs, so
enabling it for some Bots would leave the rest able to call the tool and draw nothing.

The switch reaches both halves. The server passes `openGenerativeUI` to the runtime, and
`/api/capabilities` reports the capability so the app offers the tool. The halves disagreeing is the
one configuration worth avoiding: runtime-only means the tool is never offered, and browser-only
means a Bot generates a whole interface that nothing renders.

What a generated interface can reach is what the sandbox hands it, and this deployment hands it
nothing — no session, no same-origin access to the app, no route into your data. It can load
libraries from a CDN, which is the reason a deployment that must not reach the public internet from a
browser tab should leave this unset.

**`AGENT_STALL_TIMEOUT_MS`** watches for the failure a Bot has that nothing else in the trail can
show: a stream that stops producing anything. Every other audit row is something that happened, and
this one is the absence of anything happening, which leaves no trace of its own. Ending the turn
writes `agent.stream_stalled`. Unset or `0` switches it off and nothing is watched. `.env.example`
ships `60000`, so a new clone has it on and an upgraded deployment does not acquire it unasked.

**`AGENT_TOOL_TOKEN`** exists because a framework Bot runs its own loop in its own process and still
may not reach a vendor directly. It calls the deployment that granted the tool, which is where the
grant, the policy and the audit row live. Absent, no Bot may call tools back, and it is told so
rather than quietly allowed.

That default is right for a deployment and wrong for a laptop, where it meant every granted MCP tool
was refused before it reached the grant, the boundary or the trail — and a refusal at that point is
not visible in the transcript, so a Bot reported no results rather than an error. `scripts/start.sh`
therefore generates one and writes it to `.env`, as it already does for `MANAGED_AGENT_TOKEN`. A
value already set is kept.

It is one of a pair, and they are not interchangeable: `MANAGED_AGENT_TOKEN` is the server proving
itself to a Bot, this is a Bot proving itself to the server. Rotating either means the process
holding the old one refuses every call, which is why `start.sh` restarts the server and recreates the
Bot containers on a run that mints one.

**`WORKER_SHARED_SECRET`** is the same shape of secret for a different pair: it is what the routines
worker presents to `/internal/routines/run` to prove a routine's dispatch actually came from it. The
API server refuses a handoff without one configured, and the worker refuses to start without one at
all. See [routines.md](routines.md) for what a deployment with no worker at all looks like — it is
not obvious from the screen.

Unlike `AGENT_TOOL_TOKEN`, `start.sh` does not generate and persist this one. It supplies a fixed
local default, `openbot-dev-worker-secret`, the same value every clone of this repository gets. That
is fine here not because of where the server listens — it binds no hostname, so the port itself is
reachable like any other — but because this is a dev-only default on a machine's own dev stack, and
the endpoint it guards accepts nothing but an unguessable `routine_run_<uuid>` id: the server
re-reads the routine, the owner and the channel from its own tables rather than trusting anything
else the caller says, so a well-known value from a public repository gates nothing sensitive here.
`AGENT_TOOL_TOKEN` is generated fresh and written to `.env` precisely because it is not that: it is
copied into every Bot container, and a framework Bot holding it may be running on a machine of its
own, so a fixed default there would be no boundary at all. Production deployments must set a real
`WORKER_SHARED_SECRET`.

**`SERVER_INTERNAL_URL`** is read by the worker, not by the API server, so it is not in the table
above: it says where the worker's own process can reach this deployment's API, which is a fact about
where the worker runs rather than a fact about the deployment `loadConfig` describes. `start.sh` points
it at the server's own port on a laptop; the Helm chart's routines CronJob points it at the server's
in-cluster Service address.

## Local Codex coworker

Local Codex mode runs a host-side AG-UI adapter against the Codex app-server already authenticated by
`codex login`. It is an alternative to starting the two provider-key Bot containers:

```dotenv
CODEX_AGENT_ENABLED=true
AGENT_ENDPOINT_ALLOWED_HOSTS=localhost:4202
```

`scripts/start.sh` then makes `http://localhost:4202/ag-ui` the default managed coworker endpoint,
starts the adapter on the host, and keeps its Codex thread mapping under `.openbot-codex/`. An explicit
`MANAGED_AGENT_AG_UI_URL` still wins, so remove an old `localhost:4201` value when switching modes.

| Variable                      | Default                              | Meaning |
| ----------------------------- | ------------------------------------ | ------- |
| `CODEX_AGENT_ENABLED`         | `false`                              | Starts the local Codex adapter and skips `agent-bot` and `agent-langgraph`. |
| `CODEX_AGENT_PORT`            | `4202`                               | Host port for the adapter. |
| `CODEX_AGENT_WORKSPACE`       | `.openbot-codex/workspace`           | Working directory passed to Codex turns. |
| `CODEX_AGENT_STATE`           | `.openbot-codex/threads.json`        | Durable OpenBot-thread to Codex-thread mapping. |
| `CODEX_AGENT_TURN_TIMEOUT_MS` | `180000`                             | Maximum time allowed for one Codex app-server turn. |
| `CODEX_BINARY`                | `codex`                              | Codex CLI binary to launch. |
| `OPENBOT_TOOL_URL`            | local server `/api/agent-tools/call` | Callback where assigned tools re-enter OpenBot's grant, policy and audit gateway. |

The start script supplies `MANAGED_AGENT_TOKEN` and `AGENT_TOOL_TOKEN`. When running the adapter by
hand, supply both plus `OPENBOT_TOOL_URL` and the state paths yourself. See
[the adapter guide](../agent-codex/README.md).

## OpenAI-compatible endpoints

`OPENAI_BASE_URL` decides where an OpenAI-shaped request is answered. Unset, that is OpenAI. Set, it is any endpoint speaking the same API: a gateway in front of several providers, a proxy, or a model on hardware you control.

It moves the whole deployment rather than one Bot. The API server reads it for package built-in agents, `agent-bot` reads it for the client it constructs, and `agent-langgraph` reads it for `BOT_PROVIDER=openai`.

The other two providers work the same way under their own names, because they are different APIs rather than different URLs for this one: `ANTHROPIC_BASE_URL` and `GOOGLE_GENERATIVE_AI_BASE_URL`. All three are the names the API server already reads, so one line moves the built-in agents and the Bots together and a deployment cannot end up with half of itself pointed somewhere else.

Model names travel verbatim, so use whatever the endpoint publishes. An endpoint that namespaces its catalogue wants both halves of the name, in `BOT_MODEL` and in the tenant package's `default_model` alike.

A gateway that fronts several providers behind one key is addressed the usual way:

```sh
OPENAI_BASE_URL=https://gateway.internal/v1
OPENAI_API_KEY=...
BOT_MODEL=openai/gpt-5.6-terra
```

and in the tenant package, where the name is namespaced the same way:

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: openai/gpt-5.6-terra
```

Most gateways publish a model list, which is the way to check a name before configuring it.

Two things are worth knowing before pointing a deployment at any gateway. Not every catalogue entry accepts tools, and a Bot without tool calling cannot drive its computer; the model list says which do. And `BOT_RESPONSES_API=true` needs an endpoint that implements the Responses API, not only chat completions.

## Authentication

| Variable                     | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `OPENBOT_SINGLE_USER`        | One fixed administrator and no sign-in. **Required** when no identity provider is configured, or the deployment refuses to start. Ignored when one is. |
| `GOOGLE_OAUTH_CLIENT_ID`     | Google OAuth client id.                                                                |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret.                                                            |
| `MICROSOFT_OAUTH_CLIENT_ID`  | Microsoft Entra ID application id.                                                     |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | Microsoft Entra ID client secret.                                                   |
| `MICROSOFT_OAUTH_TENANT_ID`  | Directory to admit. `common` by default, which admits personal accounts too; a GUID admits one directory. |
| `OKTA_OAUTH_CLIENT_ID`       | Okta client id.                                                                        |
| `OKTA_OAUTH_CLIENT_SECRET`   | Okta client secret.                                                                    |
| `OKTA_OAUTH_ISSUER`          | Which Okta, for example `https://example.okta.com/oauth2/default`.                     |
| `BETTER_AUTH_SECRET`         | At least 32 characters. Required with any provider.                                    |
| `BETTER_AUTH_URL`            | Public API server base URL, where OAuth callbacks return. Required with any provider.  |
| `TRUSTED_ORIGINS`            | Comma-separated app origins accepted by the API, plus every host in a registered OIDC provider's discovery document. |
| `INITIAL_ADMIN_EMAILS`       | Comma-separated administrators. **Required** with any provider.                        |
| `OPENBOT_PUBLIC_URL`         | Public address of this API. Defaults to `BETTER_AUTH_URL`.                              |
| `OPENBOT_APP_URL`            | Where the browser app is served. Defaults to the first `TRUSTED_ORIGINS` entry.          |

**With no provider at all, `OPENBOT_SINGLE_USER=true` is required.** A deployment that configures
nothing to sign anybody in and does not say that was deliberate refuses to start, naming what to
configure, because a public URL where every visitor is an administrator fails silently. `NODE_ENV`
does not enter into it. `.env.example` ships the line switched on, so a clone runs with no
configuration at all.

**Any one provider turns sign-in on**, and several may be configured at once. Each provider's id and
secret must be set together, Okta additionally needs its issuer, and any of them requires
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `INITIAL_ADMIN_EMAILS`. Every incomplete combination is
refused at start-up rather than at somebody's first attempt to sign in.

`INITIAL_ADMIN_EMAILS` is required because nothing else grants the administrator role at first: an
address it names becomes an administrator at every sign-in and cannot be demoted from the People
screen, which is what guarantees a way back in. Everybody else's role is decided there instead.

SAML and OpenID Connect providers are not configured here. They are registered while the deployment
runs, under Admin → Identity providers, and routed by email domain.

**Registering an OpenID Connect provider needs its endpoints in `TRUSTED_ORIGINS`.** Better Auth
fetches the discovery document and refuses any endpoint inside it that is not a trusted origin, which
is what stops a registration pointing the deployment at an address of somebody else's choosing. It is
every host in the document and not only the issuer, so a Google issuer also needs
`oauth2.googleapis.com` and `openidconnect.googleapis.com`; a typical Okta tenant serves all of them
from one host and needs only that. A registration refused this way names the host it objected to.

What is registered belongs to the deployment rather than to whoever registered it. Every
administrator sees the same list and can remove any of it, and a provider outlives the person who
added it. The client secret and any SAML signing material are encrypted at rest with
`KEY_ENCRYPTION_KEY`.

The redirect URI to register with each provider is `<BETTER_AUTH_URL>/api/auth/callback/<provider>`,
where `<provider>` is `google`, `microsoft` or `okta`.

`OPENBOT_PUBLIC_URL` and `OPENBOT_APP_URL` matter only for a connector each person connects their own account to, such as Google Drive.

`OPENBOT_PUBLIC_URL` builds the redirect URI the vendor sends somebody back to after they consent, which has to match what an administrator registered with that vendor character for character — so it comes from configuration rather than from the incoming request. Most deployments never set it, because `BETTER_AUTH_URL` is already the same public address. With neither, the Plugins page says the deployment cannot complete a consent flow, and no account can be connected.

`OPENBOT_APP_URL` is where the callback sends the person afterwards. It is a separate setting because the app and the API are separate addresses: locally the app is Vite on `3010` and the API is `3001`, so a relative redirect would land on the API, which serves no pages. A deployment serving both from one origin can leave it unset.

## One Bot handing work to another

| Variable                   | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `BOT_HANDOFF_MAX_DEPTH`    | How many Bots deep a chain may go. `0` switches the capability off entirely. Default `1`.    |
| `BOT_HANDOFF_MAX_PER_RUN`  | How many other Bots one run may address. Default `3`.                                        |

Both refuse rather than truncate, and both are refused at start-up if they are not whole numbers of
zero or more: a deployment that typed `two` and silently got the default would believe it had set a
cap.

Which Bots may address which is a grant, not a variable, and no Bot may address any other until one
is made. It is made on the Bot's own screen: open it from **Agents**, and switch on each Bot under
**Bots it may ask**. The pair is directional: that list is who this Bot may ask, not who may ask it,
so letting them ask each other is two switches. Only an administrator may change it; anyone who can
see the Bot can read it.

With both caps above at zero the screen says the capability is switched off, because a grant made
then is a row nothing will read.

## Computer and supervisor

| Variable                             | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AGENT_COMPUTER_URL`                 | Shared computer URL. If absent, computer routes are not mounted.                          |
| `COMPUTER_TOKEN`                     | Secret every computer request must present. The computer refuses to start without it.     |
| `COMPUTER_MAX_BROWSERS`              | How many Bots may hold a running browser at once. `8` by default; the least recently used is closed past it. |
| `COMPUTER_BROWSER_IDLE_MS`           | How long an untouched browser is kept. 30 minutes by default; `0` keeps them resident.    |
| `COMPUTER_SUPERVISOR_URL`            | Supervisor URL for per-Bot computers. If absent, Bots share `AGENT_COMPUTER_URL`.         |
| `SUPERVISOR_TOKEN`                   | Bearer token required by the supervisor.                                                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local-only private-host browsing when `true`. A deployment running with `NODE_ENV=production` refuses to start while it is set. Cloud metadata addresses are refused either way. |
| `AGENT_ENDPOINT_ALLOWED_HOSTS`       | unset | Private addresses an agent may be registered at, comma separated. Host, optionally with a port. Exact match; no wildcards. Never-allowed addresses cannot be named. |
| `AGENT_COMPUTER_POLICY`              | JSON action policy: `{"mode":"enforce","deny":[...],"allow":[...]}`.                      |
| `COMPUTER_RUNTIME`                   | Set to `runsc` to run supervised computers under gVisor.                                  |
| `COMPUTER_SANDBOX`                   | Set to `on` to enable Chromium's own sandbox where the host permits user namespaces. Which way it went is printed at start-up. |

`agent-computer` also reads:

- `ACTION_TIMEOUT_MS`
- `NAVIGATION_TIMEOUT_MS`
- `WORKSPACE_DIR`
- `PROFILES_DIR`
- `COMPUTER_BOT_ID`
- `EGRESS_PROXY_DEFAULT` (in `egress.env`, see below)
- `EGRESS_PROXY_<BOT_ID>` (in `egress.env`, see below)
- `COMPUTER_SHELL_ENV`

A command on the computer inherits PATH, locale and terminal names, and the proxy variables, not
the rest of the process environment. Userinfo is stripped from a proxy URL, so a password in
`HTTP_PROXY` is not in `env`. `COMPUTER_SHELL_ENV` is a comma-separated list of extra names to
pass. Naming a secret or a credentialed proxy there is an operator's decision; the default does not.

### Per-Bot egress

The two egress variables live in `egress.env` at the repository root, not in `.env`. `EGRESS_PROXY_<BOT_ID>`
is derived from a Bot's id, so there is no fixed set of names for Compose to list the way it lists
every other variable, and Compose passes a container only the names it is given. A file of its own
rather than `.env` because that one holds the deployment's secrets and neither the browser container
nor the supervisor is given those.

```sh
# egress.env
EGRESS_PROXY_DEFAULT=http://user:password@proxy.internal:8080
EGRESS_PROXY_SALES_BOT=http://sales.proxy.internal:8080
```

The file is optional and gitignored. Without it every Bot's browser goes out directly, which is the
default. Both the shared computer and the supervisor are given it: the computer resolves its own
proxy from these names, and the supervisor forwards them into each computer it creates.

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
| `agent-codex`     | 4202                       | `CODEX_AGENT_PORT` |
| `supervisor`      | 4500 host / 4300 container | `SUPERVISOR_PORT` |
| PostgreSQL        | 5432                       | `POSTGRES_PORT`   |

Set these in `.env` or in the environment. `docker-compose.yml` publishes on them and
`scripts/start.sh` reads the same names to decide where to look, so one setting moves a service and
everything that talks to it. The addresses built from them are separate settings, so a moved service
also needs its URL changed: `DATABASE_URL`, `AGENT_COMPUTER_URL` and `MANAGED_AGENT_AG_UI_URL`.
Codex mode derives its managed URL from `CODEX_AGENT_PORT` unless that URL is set explicitly.

To run two deployments on one Docker host, give the second one its own `COMPOSE_PROJECT_NAME`,
`COMPUTER_NAMESPACE` and `COMPUTER_IMAGE`. Container and volume names are global to a host, and the
namespace is what keeps each deployment's per-Bot computers its own.

Give it its own `DEPLOYMENT_ID` as well when it shares an Intelligence project, which a copy made
from the same `.env` does. Threads are listed per Bot and carry nothing else that says where a
conversation came from, so the name goes into every thread id a deployment mints and is how its own
conversations stay tellable from the other's.

Set `OPENBOT_ONE_COMPUTER_EACH=false` when using `start.sh` to run all Bots against one shared computer.

## Tenant package

The tenant package contains five required YAML files, and one optional:

```text
examples/fintech/
├── brand.yaml
├── agents.yaml
├── channels.yaml
├── model.yaml
├── knowledge.yaml
└── skills.yaml      (optional)
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
    system_prompt: >-
      Answer from the sources you can reach with the tools you have been given, and cite what you
      used. If you have no tool for a source, or a tool tells you it is not connected or reports an
      error, say that plainly. Never answer from your own memory as though it came from a source, and
      never claim you lack access to something a tool has just returned.

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

The two types are told different amounts, which is easy to miss. A `built-in` agent gets its
`system_prompt`; a `remote-ag-ui` agent has none, and its `role_description` is the only instruction
it ever receives from the package. Write that sentence as the whole brief for the Bot, not as a
label for a list.

Both kinds are also told, by the deployment rather than by the package, to say where an answer came
from: cite what a tool returned, and say plainly when the answer is from the model's own knowledge
rather than from anything it read. That rule is not written per agent, so it cannot be missing from
the next one somebody adds.

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

`allowed_groups` is validated and stored, and nothing reads it. It decides nothing today, and a
deployment that writes one must not treat it as an access control. Both halves of that control are
missing, not one: `users.groups` exists as a column and no sign-in path, claim mapping or admin
screen ever populates it, so there is nothing for a channel's list to be compared against. Channel
access is decided by membership alone — every channel route resolves the caller's row in
`channel_memberships` and refuses without it.

Package-declared channels get no membership rows from `synchronizeTenantPackage`, so today they
are unreachable rather than open. The field is kept because the enforcement it is named for needs
the declaration and needs group membership arriving from the identity provider, and neither this
column nor `users.groups` is the wrong shape for it.

### `model.yaml`

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: gpt-5.6-terra
```

`provider` must be `openai`. `credential_secret_ref` is a reference to a stored credential, not a credential value. `default_model` is passed through as written, so an OpenAI-compatible endpoint reached through `OPENAI_BASE_URL` takes the name that endpoint publishes.

### `knowledge.yaml`

```yaml
sources:
  - type: google-drive
    roots: [Policies, Compliance]
  - type: microsoft-onedrive
    roots: [Risk, Operations]
```

Supported source types are `google-drive` and `microsoft-onedrive`.

### `skills.yaml` (optional)

```yaml
skills:
  - slug: find-a-document
    title: Find a document
    summary: Search the connected document sources for a file and read what it says.
    instructions: >-
      Search first, then read the file you found rather than answering from its title.
    tools:
      - google-drive/search_files
      - google-drive/read_file_content
```

Each skill becomes a deployment skill on boot: everybody sees it in the `/` menu, and which Bots carry it is decided in Admin like any other.

`tools` is why this file matters beyond the instructions. A Bot holding more than twelve tools is offered, per run, only the tools of the skills that match the message, so the matching needs skills to match against. Shipping the declaration with the skill is what makes connecting a connector the only step; without it a deployment has no skills, nothing matches, and the narrowing never switches on.

Refs are `serverId/toolName`, the same form a grant is written in. A package may name tools for a connector nobody has added — the ref sits inert until that connector exists, because what a Bot is offered is always intersected with what it was granted. **Naming a tool here grants nothing.**

Slugs are lowercase letters, digits and hyphens. If a package ships a slug somebody in the deployment already wrote a skill under, theirs keeps the name, the package loses that skill, and startup continues.

Omit the file entirely for a package with no skills.

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
