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
| `CPK_INTELLIGENCE_API_KEY` | Runtime key written by the CopilotKit CLI. Preferred when non-empty. |
| `INTELLIGENCE_API_KEY` | Legacy runtime key; used when `CPK_INTELLIGENCE_API_KEY` is empty or absent. |

All five above stop server startup if missing. The three `INTELLIGENCE_` values are additionally
checked as a set, so a partial set is refused as a misconfiguration rather than treated as
unconfigured.

`COPILOTKIT_LICENSE_TOKEN` is optional: managed Intelligence issues no licence token, and a
self-hosted Intelligence that has one sets this and has it forwarded to the runtime. That
Intelligence needs the same licence on its own deployment as well, or it refuses memory and the
other licensed features while conversations carry on. OpenBot asks Intelligence once at boot and
logs `intelligence-entitlement-not-ready`, naming the fix, when the answer is not ready.

`MANAGED_AGENT_AG_UI_URL` names the Bot in the box: the default endpoint for coworkers created in
the product. It needs `MANAGED_AGENT_TOKEN` beside it, or the server refuses to start. Unset, the
server starts without a managed Bot, the shipped Risk Analyst coworker is omitted, and creating a
coworker without its own endpoint is refused. A leftover token with no URL is ignored. The
one-container image has no Bot process, so leave the URL unset there. `scripts/start.sh` points it
at `agent-langgraph` on a laptop.

## General variables

| Variable             | Default                            | Meaning                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `PORT`               | `3001`                             | API server port. `SERVER_PORT` names the same port; set either, or both to the same value, or the server refuses to start. |
| `NODE_ENV`           | unset                              | `production` refuses the example `KEY_ENCRYPTION_KEY`. It does not decide whether sign-in is required; see `OPENBOT_SINGLE_USER`. |
| `TENANT_PACKAGE_DIR` | `../examples/fintech`              | Tenant package directory, resolved from `server/`.                  |
| `DEPLOYMENT_ID`      | the tenant package's id            | Names this deployment inside a shared Intelligence project, and prefixes the identity a Shared app's account is held under at the vendor. That identity is fixed when the app is made Shared, so changing this later does not move it. |
| `OPENAI_API_KEY`     | unset                              | Default model key for built-in agents and both shipped Bots.        |
| `OPENAI_BASE_URL`    | unset                              | OpenAI-compatible endpoint that key is spent against. See below.    |
| `BOT_PROVIDER`       | `openai`                           | Provider the framework Bot (`agent-langgraph`) and the picked harness run on: `openai`, `anthropic`, or `google`. The Python Bots read it too; `agent-bot` does not, it is OpenAI only. |
| `ANTHROPIC_API_KEY`  | unset                              | Anthropic key when `BOT_PROVIDER=anthropic`.                        |
| `ANTHROPIC_BASE_URL` | unset                              | Anthropic-compatible endpoint that key is spent against.            |
| `GOOGLE_API_KEY`     | unset                              | Google key when `BOT_PROVIDER=google`.                              |
| `GOOGLE_GENERATIVE_AI_BASE_URL` | unset                   | Google-compatible endpoint that key is spent against.               |
| `BOT_MODEL`          | the Bot's row in the spec file   | Model for whichever Bot is starting. Unset, it comes from that Bot's row in [the provider spec file](#the-provider-spec-file); the provider fallbacks are `gpt-5.5`, `claude-sonnet-4-5`, and `gemini-2.5-flash`. |
| `AGENT_BOT_MODEL`    | `gpt-5.5`                          | Model for the proof-of-concept Bot (`agent-bot`), kept separate because it speaks `/v1/chat/completions` directly and refuses a model it cannot use. |
| `BOT_RESPONSES_API`  | `false`                            | Makes `agent-langgraph` use the OpenAI Responses API.               |
| `BOT_REASONING_EFFORT` | unset (provider default)         | OpenAI and the Responses API only: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `agent-langgraph` refuses to start on any other value, on a non-`openai` provider, or without the Responses API. |
| `AGENT_STALL_TIMEOUT_MS` | unset (off)                    | How long a Bot's stream may produce nothing before the turn is ended for it. |
| `AGENT_TOOL_TOKEN`   | unset; `start.sh` generates one    | The secret a framework Bot presents when it calls a granted tool back through this server. |
| `APP_DIST_DIR`       | unset                              | Where the built app is, when this process serves it. Set inside the container image; unset in development, where Vite serves the app. |
| `AUDIT_RETENTION_DAYS` | unset                            | Whole number of days to keep audit rows; older ones are removed. Unset keeps the trail forever. |
| `WORKER_SHARED_SECRET` | unset; `start.sh` uses a fixed local default | The secret the routines worker presents to fire a due routine. Without it the server refuses every handoff, whether or not a worker exists to send one. |
| `OPENBOT_GENERATIVE_UI` | unset (capability on)               | Set `false` or `0` to stop Bots from answering with generated interfaces. |
| `OPENBOT_SELF_HOST_BANNER` | unset (banner on)               | Set `false` or `0` to hide the bar offering help self-hosting OpenBot, for everybody. It never shows on a paid Intelligence plan, and each person can also close it for themselves. |
| `OPENBOT_ACCESSIBILITY_DISABLED` | unset | `true` or `1` stops naming OpenBot on the analytics the runtime already sends. |
| `COMPOSIO_API_KEY`   | unset                              | One key for the whole deployment, for the broker that holds people's accounts for a few hundred apps. Unset, there is nothing to connect, nothing to grant and no Composio tool for a Bot to call; what remains is one row that goes nowhere, under **More apps** on the admin Plugins page, naming this variable. See [Composio](plugins/composio.md). |

**`OPENBOT_GENERATIVE_UI`** enables generated interfaces by default: streamed HTML/CSS/JavaScript
in a sandboxed iframe, and A2UI 1.0 interfaces built from its 18 basic components. Their buttons send
their named action and the values entered back to the current conversation's Bot.
Set `OPENBOT_GENERATIVE_UI=false` or `0` to disable both. `true`, `1`, an empty value, or an unset
value leave the capability on. The server configures both runtime renderers and reports the same
setting through `/api/capabilities` to the browser.

**`OPENBOT_SELF_HOST_BANNER`** shows a slim bar at the top of the signed-in app offering
CopilotKit's help self-hosting OpenBot, linking to `https://copilotkit.ai/talk-to-an-engineer` with
`ref=openbot_app`. Closing it is saved to that person's preferences, so it stays closed on every
device they sign in from. Set `false` or `0` to hide it for everybody, which suits a fork running
OpenBot for its own organization. Any other value, or none, leaves it on.

Left on, it still never shows on a deployment that pays for Intelligence. The server reads the
deployment's Intelligence entitlement and hides the bar when it is active on a paid plan (`pro`,
`team`, `team_self_hosted` or `enterprise`) or comes from an AWS Marketplace licence. A free or
developer plan, an inactive entitlement, and one that cannot be read all show it. The answer is
kept for ten minutes, so a plan bought today hides the bar within ten minutes, and a page waits at
most a second for the first answer after the server starts. In Helm, set the variable through
`config.extraEnv`.

The component catalogue has separate per-Bot grants. Its sortable data table (`showTable`),
interactive form (`askForm`), and other compiled or playground-authored components remain governed
by those grants. In Admin → Playground, edit a draft and its sample arguments, preview it, then
publish it for Bots to use. Only published code renders in conversations and the administrator's
gallery; invalid JSON blocks saving and publishing.

Generated HTML runs without the app's session or same-origin access to its data. It can load
libraries from a CDN; deployments that prohibit that browser traffic can disable generated UI.

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
all. See [routines.md](routines.md) for what a deployment with no worker at all looks like — the
Routines page says so when nothing has swept.

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

## The provider spec file

`shared/model-providers.json` is one file, and every language in the box reads it: the TypeScript
Bots through `shared/model-providers.ts`, the Python Bots through `shared/model_providers.py`, and
any other implementation straight as JSON. The one Bot that does not is `agent-claude-sdk`, which has
no `bots` row. It has two sections: the facts per provider, and the
provider and model each Bot runs:

```json
{
  "providers": {
    "openai": {
      "label": "OpenAI",
      "key_variable": "OPENAI_API_KEY",
      "base_url_variable": "OPENAI_BASE_URL",
      "default_model": "gpt-5.5"
    }
  },
  "bots": {
    "agent-langgraph": { "provider": "openai", "model": "gpt-5.5" },
    "agent-adk": { "provider": "openai", "model": "gpt-4o-mini" }
  }
}
```

The lookup order for `BOT_PROVIDER` and `BOT_MODEL` is unchanged, and the file sits in the middle
of it:

1. the environment — how a deployment overrides what the repository decided;
2. the Bot's row in this file — what the repository decided;
3. the provider's `default_model` — what is left when neither says.

Each Bot retains its existing default: for example, `agent-mastra` uses `gpt-4o-mini`, while
`agent-langgraph` uses `gpt-5.5`. Editing a Bot's row changes that Bot's default without changing
another Bot's choice. The Python LangGraph harness also accepts `BOT_PROVIDER=google_genai` as an
alias for the spec's `google` provider.

A blank value is read as unset, which is what a compose file passing `${BOT_MODEL:-}` hands a Bot
when nobody chose a model. API keys never appear in the file: they arrive in the environment
under the `key_variable` the provider row names.

Adding a Bot in any language is adding one `bots` entry — `"agent-java": { "provider":
"anthropic", "model": "claude-sonnet-4-5" }` — after which that Bot resolves its model the same
way everything else does. A row that names a provider no `providers` entry exists for, or leaves a
field empty, stops every Bot at startup with the path of the key that is wrong, rather than at the
first model call.

Adding a **provider** is three places rather than one: a row under `providers` here, one entry to
`PROVIDER_IDS` in `shared/model-providers.ts`, and one entry to `PROVIDER_IDS` in
`shared/model_providers.py`. Each loader checks this file against its own list in both
directions, so neither the Python Bots nor the TypeScript ones start against a provider row their
own loader has never heard of, nor against a provider their own loader names when the file has no
row for it. Either refusal names the key that is wrong, at startup rather than at the first model
call, in either language.

`agent-bot` is the one Bot that pins its provider: it speaks `/v1/chat/completions` directly and
has never read `BOT_PROVIDER`, and `bots.agent-bot` supplies only its model.

## OpenAI-compatible endpoints

`OPENAI_BASE_URL` decides where an OpenAI-shaped request is answered. Unset, that is OpenAI. Set, it is any endpoint speaking the same API: a gateway in front of several providers, a proxy, or a model on hardware you control.

It moves the whole deployment rather than one Bot. The API server reads it for package built-in agents, `agent-bot` reads it for the client it constructs, and `agent-langgraph` reads it for `BOT_PROVIDER=openai`.

`OPENAI_CONTAINER_BASE_URL` overrides that value inside the Bot containers only, for an endpoint the containers reach by a different route than the host does. Unset, the containers use `OPENAI_BASE_URL` like everything else.

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

The built-in Bots call a gateway's Chat Completions API (`/chat/completions`), which every OpenAI-compatible endpoint serves, unless their model takes tools only through the Responses API: `gpt-5.6` and later, the `-pro` models and `gpt-5.3-codex`, under a gateway's `openai/` name too. For those they call `/responses`, which a gateway or a proxy in front of OpenAI also serves. `COPILOTKIT_OPENAI_API=responses` or `chat` picks one API for every model instead.

## Voice dictation

Dictation inserts recorded speech into the composer for review before sending. It works with any
agent because the agent receives an ordinary text message. Audio configuration is independent of
the chat model provider; neither `OPENAI_BASE_URL` nor `OPENAI_API_KEY` is inherited.

| Variable | Meaning |
| --- | --- |
| `TRANSCRIPTION_PROVIDER` | `openai-compatible`, the first transcription adapter. Unset with all other transcription variables unset disables dictation. |
| `TRANSCRIPTION_BASE_URL` | Explicit API base URL, including the version path if required. The adapter appends `/audio/transcriptions`. |
| `TRANSCRIPTION_MODEL` | Required model name, passed verbatim to the configured service. |
| `TRANSCRIPTION_API_KEY` | Dedicated server-side bearer credential. Optional for services that intentionally require no authentication. |

For OpenAI, set the base URL to `https://api.openai.com/v1` and select an available transcription
model such as `gpt-transcribe`. A compatible local endpoint can instead use
`http://127.0.0.1:8000/v1` and its own model name. Compatibility with chat completions alone does
not imply transcription support. See the [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text).

The composer shows the microphone when the service is configured. Browser microphone access needs
HTTPS or localhost. While recording, a live waveform replaces the editor and normal controls.
Press **Stop** to transcribe into the draft, **Send** to transcribe and submit, or **Cancel** to
discard the recording. **Retry** retries a failed transcription with the same selected action.
Text is appended to the current draft, preserving edits, mentions, and files. A failed send restores
the combined draft through the normal message flow. The waveform shares the recorder's microphone
stream and does not use an ElevenLabs service or credential.

The browser stops recording at two minutes. Uploads are limited to 10 MiB, and provider requests
time out after 60 seconds. There is at most one active transcription per user and eight per server
process. These are concurrency limits, not a distributed usage quota; deployments requiring spend
quotas should also enforce them at their audio gateway. Provider failures never switch to another
service. OpenBot keeps audio in memory only, retaining a failed recording in the browser for retry
until cancellation or navigation. Your configured provider's retention policy still applies.

Dictation is separate from live voice calls and does not enable them automatically.

## Live voice calls

The waveform button in an existing channel opens a floating call widget. The realtime voice model
handles conversation, advice, and brainstorming directly, using the selected agent's identity.
Requests needing tools, connected accounts, current facts, or specialist work are delegated to that
channel's existing agent. Delegated requests, agent replies, tools, and generated interfaces use the
normal AG-UI thread. The voice model speaks the returned result and continues the conversation.
Joining includes recent thread messages and previous voice chats, capped at 12,000 characters.

Ending a nonempty call saves its text transcript to the database and creates a compact, expandable
Voice chat card in the same channel. A separate summary request uses the deployment's default chat
model and its existing credential: OpenAI-compatible or Anthropic API keys, Claude or ChatGPT plan
sign-in, or the deployment's Google/xAI OAuth proxy. It does not need a separate OpenAI key when
another provider is selected. Plan summaries use an isolated conversation with no tools. A failed
summary leaves the saved transcript available with a retry button. A successful retry updates the
sidebar preview only while that call is still the latest activity. Interrupted answers are marked
as interrupted rather than treated as fully heard.
Later voice calls and typed agent requests receive the saved voice context. Voice cards are stored
separately from AG-UI messages; ordinary voice conversation does not trigger an agent run.

The browser temporarily keeps unconfirmed transcripts in a local outbox scoped to the signed-in
user, so a failed save or closing the tab can be recovered on returning to the channel. Confirmed
saves are removed from that outbox. No call audio is recorded by OpenBot.

| Variable | Meaning |
| --- | --- |
| `VOICE_PROVIDER` | `openai-realtime` or `xai-realtime`. All voice variables unset disables calls. |
| `VOICE_MODEL` | Required realtime voice model available to your provider account. |
| `VOICE_API_KEY` | Required server credential. Set explicitly; no chat or dictation credential is inherited. Bun `.env` files can explicitly reference `$OPENAI_API_KEY` or `$XAI_API_KEY`. |
| `VOICE_NAME` | Provider voice name; defaults to `marin` for OpenAI or `ara` for Grok. |

OpenAI uses WebRTC, with an authenticated OpenBot endpoint exchanging the browser's SDP offer
using server-owned session configuration. Grok uses WebSocket PCM audio at 24 kHz; OpenBot mints
a short-lived client credential and returns the configured session. Permanent keys stay on the
server. Microphone audio travels directly between the browser and the chosen voice provider.
These are separate transports behind one call interface; an OpenAI-compatible transcription API
does not imply realtime voice support.

Calls require HTTPS or localhost, microphone permission, and browser audio playback. You can mute,
minimize, or end the call. Joining is silent: the agent waits for you to speak. Mute affects only
your microphone; you can still hear the agent. The compact widget shows both participants, with
optional live captions in call settings. Speaking interrupts audio playback. Agent actions already started
continue until completion or the stop button in chat is pressed; hanging up does not undo work.
A second agent request while the thread is busy is refused with an explanation rather than run
concurrently. Existing typed-message queuing remains available. Switching channels or leaving the
page ends the call, and calls do not automatically reconnect or repeat actions. The browser ends
calls after fifteen minutes; this is a UX limit, not an enforceable provider spending quota.

Configuration enables the voice call button but does not prove provider/model availability. Connection
failures appear in the widget while text chat remains available. The call endpoint verifies channel
membership and limits connection attempts. OpenBot does not record call audio; provider retention
policies apply. See [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) and
[Grok Voice](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech).

## Authentication

| Variable                     | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `OPENBOT_SINGLE_USER`        | One fixed administrator and no sign-in. **Required** when no identity provider is configured, or the deployment refuses to start. Refused on a public address. Ignored when a provider is configured. |
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
| `SIGNIN_ALLOWED_EMAIL_DOMAINS` | Comma-separated email domains admitted at sign-in. Empty means no opinion. Exact, no wildcards. |
| `OPENBOT_ORGANIZATION_AUTH_URL` | An OpenBot deployment that verifies employee identity and roles. Decides sign-in ahead of `OPENBOT_SINGLE_USER`. |
| `OPENBOT_RECORDER_EXTRA_EXTENSION_IDS` | Extra extension ids OpenBot trusts besides the Recorder's own, for a fork or a build signed with another key. Comma separated, each 32 letters from a to p, or the server refuses to start. Unset trusts only the Recorder's own id. |

**Some variables belong to the desktop app, not to you.** A desktop installation writes these into
its own deployment's `.env` and owns their values: `OPENBOT_MODEL_OAUTH_FILE`, `CHATGPT_AUTH_FILE`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENBOT_BROWSER_URL` and `BROWSER_PORT` (the person's own browser, see
[OpenBot Desktop runs it for the person](#openbot-desktop-runs-it-for-the-person)), and the
`PICKED_HARNESS_*` names that describe the Bot picked during setup
(`PICKED_HARNESS_IMAGE`, `PICKED_HARNESS_URL`, `PICKED_HARNESS_PORT` and the rest). The server reads
`PICKED_HARNESS_IMAGE` and `PICKED_HARNESS_URL` to hand that Bot `MANAGED_AGENT_TOKEN`, and refuses to
start when they are set without it. When a model provider is connected by OAuth rather than by key, the
desktop also points `OPENAI_BASE_URL` at OpenBot's own loopback route and sets `OPENAI_API_KEY` to a
local proxy credential rather than a provider key, so those two do not mean what the table above says
in that mode. A server you configure yourself is unaffected by all of this.

**With no provider at all, `OPENBOT_SINGLE_USER=true` is required.** A deployment that configures
nothing to sign anybody in and does not say that was deliberate refuses to start, naming what to
configure, because a public URL where every visitor is an administrator fails silently. `NODE_ENV`
does not enter into it. `.env.example` ships the line switched on, so a clone runs with no
configuration at all. `OPENBOT_DEV_NO_AUTH=true`, the flag's former name, is still honoured.

**But not on a public address.** The flag says you meant an open deployment; it does not say who can
reach it. If `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or any `TRUSTED_ORIGINS` entry is an address
the public internet routes to, the deployment refuses to start and names it. Loopback is silent. A
private address is allowed and warned about once at boot, because a home server, a Tailnet, a VPN
address and a `.local` name are what this flag is mostly used for, and anybody on that network is
the administrator. A value that cannot be parsed as a URL counts as public, because nobody checked
it.

**`SIGNIN_ALLOWED_EMAIL_DOMAINS` decides who may sign in**, as distinct from who is an
administrator once in. Matching is exact with no wildcards, so `example.com` admits neither
`sub.example.com` nor `evil-example.com`, and both sides go through the same IDNA normalisation, so
a rule may be written `@Example.COM.` or in punycode and still mean what it says. Two arrangements
are refused at start-up rather than documented and hoped for: a list that normalises to nothing,
which `@` and a stray `.` both produce, because it is a non-empty list no address can match; and a
list combined with a `MICROSOFT_OAUTH_TENANT_ID` that names no directory (`common`, `organizations`
or `consumers`), because there the address the list is checked against is one the signing-in tenant
writes for itself. A production deployment that names no domains and leaves the tenant multi-tenant
is warned rather than refused.

**`OPENBOT_ORGANIZATION_AUTH_URL` names an authority, not a provider.** It must be an HTTPS OpenBot
origin, or HTTP on loopback, and a bare origin: a username, password, query, fragment or any path
other than `/` is refused at start-up. Naming one settles sign-in by itself, ahead of
`OPENBOT_SINGLE_USER`.

**A browser connected with the OpenBot Recorder is signed in as its person, and only while they
are.** Its connection ends after a week unused, as a session does, or, with
`OPENBOT_ORGANIZATION_AUTH_URL`, when the organization session cookie it was connected with expires.
It ends at once when the person signs out, when their sessions are ended any other way (signing out
everywhere, the directory deactivating them, SSO-required being turned on, or their organization
ending the session), and when they are removed. A sign-out that cannot end their Recorder connections
does not happen: the person is told to try again, still signed in, and a `recorder.sign_out_failed`
row goes on the audit trail.

**Recordings cannot be deleted from OpenBot yet.** A recording goes from the person's browser to
Intelligence, into their own Learning space (see [Automatic Learning](automatic-learning.md));
OpenBot keeps only which recordings are whose. Intelligence has no API a server credential can call
to delete a recording, or a Learning space that still holds one, so nobody can delete a recording
from OpenBot, and a person's recordings stay in Intelligence after they are removed from OpenBot.

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

A [Composio](plugins/composio.md) app needs `OPENBOT_APP_URL` and nothing else of the two: the consent lives at the broker, so no redirect URI of ours is registered anywhere, but the address Composio returns somebody to has to be absolute and this is where it comes from. Connecting a brokered account refuses where it resolves to nothing, rather than sending somebody to a consent screen with no way back.

### SCIM provisioning

A directory such as Okta or Entra ID can create, update and remove people through SCIM 2.0 at
`<BETTER_AUTH_URL>/api/auth/scim/v2`. It is off while `SCIM_BEARER_TOKEN` is unset.

| Variable                 | Meaning                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `SCIM_BEARER_TOKEN`      | The token the directory sends as a bearer token. Setting it switches SCIM on.                              |
| `SCIM_BEARER_TOKEN_NEXT` | Optional second token accepted beside the first, so the directory can move to a new one before the old one is removed. |
| `SCIM_CONNECTION_ID`     | The name of the directory connection. Defaults to `directory`.                                             |

A person the directory creates gets the `user` role, or `admin` when their address is in
`INITIAL_ADMIN_EMAILS`, and still signs in through the company's identity provider: SCIM creates no
password. Their directory groups become their OpenBot groups, which per-group capability switches
and network policies read. Deactivating or deleting someone in the directory ends their sessions,
deny-lists the address, retires the connector credentials they granted and their linked accounts
(see Linked accounts), and stops their Bots' computers. Reactivating them lifts a deny-list entry
SCIM wrote, never one an administrator wrote.

## One Bot handing work to another

| Variable                   | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `BOT_HANDOFF_MAX_DEPTH`    | How many Bots deep a chain may go. `0` switches the capability off entirely. Default `1`.    |
| `BOT_HANDOFF_MAX_PER_RUN`  | How many other Bots one run may address. Default `3`.                                        |

Both refuse rather than truncate, and both are refused at start-up if they are not whole numbers of
zero or more: a deployment that typed `two` and silently got the default would believe it had set a
cap.

Which Bots may address which is a grant, not a variable, and no Bot may address any other until one
is made. It is made on the Bot's own page: open it from **Bots**, choose **Skills and access**, and switch on each Bot under
**Bots it may ask**. The pair is directional: that list is who this Bot may ask, not who may ask it,
so letting them ask each other is two switches. Only an administrator may change it; anyone who can
see the Bot can read it.

With both caps above at zero the screen says the capability is switched off, because a grant made
then is a row nothing will read.

## Slack and Microsoft Teams (OpenTag pairing)

OpenBot reaches people in Slack and Teams through [OpenTag](https://github.com/CopilotKit/OpenTag),
the open-source Channels SDK front. OpenTag calls OpenBot as its AG-UI agent; OpenBot does not hold a
Slack app of its own.

| Variable                        | Meaning                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENTAG_SHARED_SECRET`         | Enables the pairing. At least 32 characters. OpenTag must send `Authorization: Bearer <secret>` (its `AGENT_AUTH_HEADER`), and OpenBot sends the same header on proactive posts. |
| `OPENTAG_URL`                   | OpenTag's base URL, for messages sent when no Slack turn is open (replies after an approval, responsibility progress, questions). Without it those sends fail visibly in the outbox, and Slack triggers are refused because channel membership cannot be checked. |
| `OPENTAG_BOT_ICON_URL_TEMPLATE` | Optional `https` PNG URL with `{seed}` (the Bot's avatar seed) or `{agentId}`, used as the Bot's Slack icon on proactive posts.                                                    |

Point OpenTag's `AGENT_URL` at `<public URL>/api/delivery/webhooks/opentag/agent`. A person links
their Slack or Teams identity from a Bot's page, under **Reaching you**: OpenBot shows a one-time `link <code>` message,
valid for ten minutes, which they send to the OpenTag app. After that, only that person's messages
reach their chosen Bot, in their own OpenBot conversation, with learning, governance, approvals and
audit on every turn. Anyone unlinked is told how to link and nothing runs. Approval requests appear
as OpenTag approval cards (allow once, always allow, cancel) and are decided through the approvals
service as the linked owner; a reply to a Bot's question answers that question.

The former direct Slack settings (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_BOT_TOKEN`,
`SLACK_TEAM_ID`, `SLACK_SIGNING_SECRET`) are refused at start-up; unset them.

SMS through Twilio honours Advanced Opt-Out: `STOP` (and Twilio's other opt-out keywords) marks the
number opted out, later messages show `opted_out` in the delivery history instead of being sent, and
`START` resumes. Twilio sends the confirmation reply itself, so OpenBot does not.

## Linked accounts

OpenBot keeps a record of a person's accounts at outside providers, such as their GitHub account
or their Slack user. Each provider is a row on `/connections`, beside the apps, listed when the
person has linked it or this deployment can link it. The row opens the provider's own page
(`/connections/github`, `/connections/slack`), whose **Your account** section shows the link with a
**Disconnect** button, or **Connect** where it can be linked. GitHub's page also lists the
repositories whose events can start a responsibility, and links to a Composio GitHub app where one is
enabled, which is then left out of the list so GitHub appears once. Disconnecting removes the link and revokes
OpenBot's stored copy of any token kept with it, and is audited. For GitHub, the grant itself stays
at GitHub until the person revokes it under GitHub, Settings, Applications.

See "Linking Slack and GitHub accounts" below for setting up each provider. An integration proves an
account in one of two ways: by the provider's own sign-in, or by a one-time code that OpenBot issues
to the signed-in person and that they send from their chat account. Whoever sends the code gets that
chat account linked to the person it was issued to, so treat it like a password and do not share it.
It is valid for ten minutes and works once, and issuing a new code for the same provider invalidates
the earlier one. An outside account links to one OpenBot user at most. Linking a new account at a
provider and workspace replaces the person's earlier link there and revokes its token.

Removing a person, whether an administrator does it or a SCIM deactivation does, retires their
links. Their unused link codes are deleted, any token stored with a link is revoked, and each link is
marked as needing reconnection. The links are kept, not deleted, so the outside account still
resolves to the removed person and is refused rather than treated as an unlinked guest. Each retired
link is recorded in the audit trail.

### Linking Slack and GitHub accounts

Slack is offered only where the OpenTag Slack webhook is set up (the pairing above, so
`OPENTAG_SHARED_SECRET` must be set) and the server can redeem identity codes. The person clicks
**Connect** on Slack's page, which shows a message of the form `link <code>`, and sends it to the
OpenBot app in a direct message within ten minutes. A code sent in a channel is refused and stays
valid until it expires. Teams cannot be linked this way.

GitHub uses a GitHub App. Create one under GitHub Settings, Developer settings, GitHub Apps, and set:

- The callback URL to `<public URL>/api/identity/github/callback`, where the public URL is
  `OPENBOT_PUBLIC_URL` or, if that is unset, `BETTER_AUTH_URL`. With neither set, the server
  refuses to start when `GITHUB_APP_CLIENT_ID` is present.
- "Expire user authorization tokens" on. A webhook is not required for linking.
- A client secret, generated on the App's page.

Then set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`; set both or neither. People
then use **Connect** on GitHub's page while signed in to OpenBot in the same browser. The GitHub
user token is stored encrypted with the link.

After GitHub, the browser is sent back to GitHub's page under Connections, at `OPENBOT_APP_URL`, else the first `TRUSTED_ORIGINS` entry,
else the public URL. Set `OPENBOT_APP_URL` when the app and the server are on different origins, as
in local development (app on `3010`, server on `3001`); one origin needs nothing.

Reachability codes and account-link codes look alike, and Reachability's are checked first. A
Reachability `link <code>` binds a conversation for delivery and is not recorded as a linked
account; a `link <code>` from Slack's page under Connections links the Slack user.

## Text messages and push notifications

A provider is switched on by setting its variables and is off while none of them are set. Setting
some of a provider's variables and not all of them stops the server at start-up with
`Delivery configuration is incomplete:` and the names that are missing.

| Variable                    | Meaning                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELIVERY_PUBLIC_URL`       | The public origin providers call back on, such as a tunnel or an ingress. Twilio signs each request over the URL it was given, so this has to be the address Twilio was configured with. Unset, OpenBot uses `OPENBOT_PUBLIC_URL`, then `BETTER_AUTH_URL`. It must be an `http(s)` URL or the server does not start. |
| `TWILIO_ACCOUNT_SID`        | Twilio account SID. One of the four SMS settings, which are set together.                                                                                                                                                                          |
| `TWILIO_AUTH_TOKEN`         | Twilio auth token. Used to send and to check the signature on every request Twilio makes.                                                                                                                                                         |
| `TWILIO_VERIFY_SERVICE_SID` | The Twilio Verify service that texts the code a person enters under a Bot's **Reaching you** to confirm their number.                                                                                                                            |
| `TWILIO_FROM_NUMBER`        | The Twilio number OpenBot sends from.                                                                                                                                                                                                              |
| `EXPO_PROJECT_ID`           | The native app's EAS project id, a UUID. Switches on push notifications and sign-in from the native app (without it, the server does not trust the app's `openbotmobile://` sign-in redirect). A device registers only when the app reports this same project id; any other value is refused. A value that is not a UUID stops the server at start-up.                  |
| `EXPO_ACCESS_TOKEN`         | Optional. Sent as `Authorization: Bearer` on every request to Expo's push service; without it those requests carry no token.                                                                                                                       |

With SMS on, point the Twilio number's incoming-message webhook at
`<DELIVERY_PUBLIC_URL>/api/delivery/webhooks/sms`. OpenBot passes
`<DELIVERY_PUBLIC_URL>/api/delivery/webhooks/sms/status` to Twilio as the status callback on each
message it sends.

The native app in `mobile/` reads two variables of its own when it is built, from `mobile/.env`:
`EXPO_PUBLIC_SERVER_URL`, the deployment's public URL (required, `https` outside development, no
credentials or query string), and `EXPO_PUBLIC_EAS_PROJECT_ID`, the same project id as
`EXPO_PROJECT_ID` above.

## Inbound email triggers

An email trigger gets its own address, `trigger-<triggerId>@<OPENBOT_INBOUND_EMAIL_DOMAIN>`. Mail
reaches OpenBot through Amazon SES receiving: a receipt rule for the whole domain publishes to an
SNS topic, and that topic has an HTTPS subscription to `<public URL>/api/events/email/sns`. OpenBot
checks each SNS message's AWS signature and refuses any topic not listed, because a valid signature
proves AWS sent the message, not that the topic is yours. It confirms the subscription itself when
SNS asks.

| Variable                               | Meaning                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `OPENBOT_INBOUND_EMAIL_DOMAIN`         | The domain the receipt rule covers, such as `in.example.com`.                                 |
| `OPENBOT_INBOUND_EMAIL_SNS_TOPIC_ARNS` | Comma-separated ARNs of the SNS topics allowed to deliver mail.                               |

Both are needed. With either missing, the email route is not mounted, and an email trigger has no
address: its page and the Bot both say inbound email is not configured on this deployment.

## Automatic Learning

Learning is on by default; with no container assigned, nothing is collected or delivered and the
deployment still starts and chats. Until something is saved, the server assigns its Intelligence
project's `openbot` container as the default by itself once that container exists. The variables
below are optional; an administrator's saved settings under **Admin → Automatic Learning** override
them, including a saved off. See [automatic-learning.md](automatic-learning.md).

| Variable                                 | Meaning                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` | Default Learning container for this deployment's Bots. 1 to 64 lowercase letters, digits and single hyphens, or the server refuses to start. |
| `CPK_INTELLIGENCE_SKILLS_REVISION`       | An exact published skills revision to pin. Read only beside a container id. Unset follows the latest. |
| `OPENBOT_LEARNING_AUTO_ASSIGN`           | `false` or `0` stops the server assigning the project's `openbot` container automatically. On otherwise, and off whenever `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` is set. |
| `INTELLIGENCE_SERVICE_TOKEN`             | An Intelligence service token that creates the `openbot` Learning container (local evaluation installs only; see [Creating the container](automatic-learning.md#creating-the-container)). Requires `INTELLIGENCE_PROJECT_ID`. |
| `INTELLIGENCE_PROJECT_ID`                | The numeric ID of the runtime key's Intelligence project, where the service token creates the container. Set both or neither, or the server refuses to start. |
| `OPENBOT_MEMORY_SOURCE_DEFAULTS`         | `false` or `0` stops OpenBot making each app a person connected into a memory source for the Bots they talk to. On otherwise. Existing sources are left as they are. |
| `OPENBOT_PROACTIVE_DEFAULTS`             | `false` or `0` stops OpenBot switching on background research for the Bots a person talks to. On otherwise. Existing settings are left as they are. |

## OpenTelemetry export

Every audit row is also sent as an OTLP log record over HTTP, so a SIEM or an OpenTelemetry
Collector receives the same events the **Audit** page shows, as they happen. Each record carries
`openbot.surface`: `bot`, `identity` or `control_plane`. Export never stops a request: when the
collector cannot be reached, records are dropped after the SDK's retries, and the row in PostgreSQL
is still the record.

| Variable                           | Meaning                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Where log records go, used exactly as written. Takes precedence over the next one.                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`      | Collector base URL; OpenBot appends `/v1/logs`. Setting either endpoint switches export on.           |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS`  | Headers for the logs endpoint, as `key=value` pairs separated by commas (for a collector's API key).  |
| `OTEL_EXPORTER_OTLP_HEADERS`       | The same, used when `OTEL_EXPORTER_OTLP_LOGS_HEADERS` is unset.                                        |
| `OTEL_SERVICE_NAME`                | The `service.name` on every record. Defaults to `openbot`.                                             |
| `OPENBOT_OTEL_EXPORT`              | `off` turns export off while an endpoint is still set.                                                 |

## Computer and supervisor

| Variable                             | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AGENT_COMPUTER_URL`                 | Shared computer URL. If absent, computer routes are not mounted.                          |
| `COMPUTER_TOKEN`                     | Secret every computer request must present. The computer refuses to start without it.     |
| `COMPUTER_MAX_BROWSERS`              | How many Bots may hold a running browser at once. `8` by default; the least recently used is closed past it. A person's browser in a native window (OpenBot Desktop) counts toward it and is closed only when no Bot's browser is left to close; a person's cloud browser is ranked by use like a Bot's. |
| `COMPUTER_SEPARATE_WORKSPACES`       | `on` gives each Bot its own folder of files on a computer many Bots share, with its shell starting there. On for Helm's `shared` computer and the docker-compose `agent-computer`; off elsewhere. Files saved before it was on stay at the root of the volume. Commands can still read other folders: use `computers.mode: sandbox` to keep people apart. |
| `COMPUTER_BROWSER_IDLE_MS`           | How long an untouched browser is kept. 30 minutes by default; `0` keeps them resident. A person's cloud browser takes the same rule: the Browser page touches it every second while it is open, so it closes once nobody is on that page. A person's native window (OpenBot Desktop) is never closed for being idle. |
| `COMPUTER_MEMORY_HIGH_PERCENT`       | At what share of its memory limit a computer starts closing browsers nobody is using, least recently used first and one at a time, until it is ten points under that share (75% at the default). `85` by default; `0` switches it off. Memory is the container's working set, as the kubelet reads it (usage less the inactive page cache), checked before every launch and every minute, one pass at a time however many launches arrive together. It is a check, not a guarantee: a page that grows between two checks can still run the container out of memory. A container with no limit is measured against the machine's memory; a computer outside a container (OpenBot Desktop's) closes nothing for memory. Never closed for memory: the browser being launched, the most recently used one, any used in the last minute, a person's own browser (cloud or native), and a Bot's whose wheel a person holds or has been asked to take. In the all-in-one image the share counts the database and the API server as well as the browsers, on purpose: the kernel's out-of-memory kill counts them too and can take the database down, and closing a browser first is how the database is protected. Each close logs `computer-browser-closed-for-memory` with the working set and the limit in bytes. |
| `COMPUTER_TAB_IDLE_MS`               | How long a Bot's background tab may sit untouched before it is closed. 10 minutes by default; `0` keeps them. A Bot is always on its newest page, so an older tab (the page a sign-in popup opened from, a link opened in a new tab) is one it cannot go back to. Navigating, being acted on, or being in front counts as use. Never closed: the page the Bot is on, a person's own browser, and any tab of a Bot whose wheel a person holds. |
| `OPENBOT_RECORDER_DIR`               | The built OpenBot Recorder (`extension/dist` after `bun run build`), absolute. Every person's browser the computer opens has it loaded and connected. Every Bot's browser has it loaded too (except in local Chrome), disconnected and silent until a person holding the Bot's control presses Record. Without it, or pointed at anything that is not a built Recorder, the computer still serves Bots, whose browsers then launch without it and cannot record, and refuses to open a person's browser, saying why. The computer image sets it to the Recorder it carries. |
| `COMPUTER_PEOPLE_ONLY`               | `on` for a computer that runs people's own browsers and no Bot (OpenBot Desktop sets it on its host-side computer); it refuses every Bot. A person's browser runs only on a computer of its own: this one, or one started for it alone (`COMPUTER_BOT_ID`, as the supervisor and a Sandbox start each computer). The shared computer refuses it, and so does the server, whose Browser page says why, because a Bot's shell there could read the person's logins off the disk. |
| `COMPUTER_BROWSER_BACKEND`           | `managed` by default (full bundled Chromium); `local-chrome` opts into installed Chrome with dedicated profiles and a loopback API. |
| `COMPUTER_BROWSER_MODE`              | Managed defaults to `headed` on Linux, which is every hosted computer (a container, a pod, the desktop app's engine): full Chromium on the computer's own Xvfb display. A computer run directly on macOS or Windows defaults to `headless`, where headed would open windows on the desktop. `headless` is full Chromium's new headless mode. Local Chrome requires `headed`. See [Getting past bot checks](#getting-past-bot-checks). |
| `WEB_BOT_AUTH`                       | `on` or `off`. Unset means off. `on` needs an https public URL. See [Web Bot Auth](#web-bot-auth). |
| `WEB_BOT_AUTH_KEY`                   | The Web Bot Auth signing key, an Ed25519 private JWK. Unset derives one from `KEY_ENCRYPTION_KEY`. Never logged. |
| `OPENBOT_LOCAL_COMPUTER_DIR`         | Local startup helper's absolute data root. Defaults to the platform's OpenBot user-data directory; contains `profiles/` and `workspace/`. |
| `COMPUTER_SUPERVISOR_URL`            | Supervisor URL for per-Bot computers. If absent, Bots share `AGENT_COMPUTER_URL`.         |
| `SUPERVISOR_TOKEN`                   | Bearer token required by the supervisor.                                                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local-only private-host browsing when `true`. A deployment running with `NODE_ENV=production` refuses to start while it is set. Cloud metadata addresses are refused either way. |
| `AGENT_ENDPOINT_ALLOWED_HOSTS`       | Private addresses an agent may be registered at, comma separated; unset (none) by default. Host, optionally with a port. Exact match; no wildcards. Never-allowed addresses cannot be named. |
| `AGENT_COMPUTER_POLICY`              | JSON action policy: `{"mode":"enforce","deny":[...],"allow":[...]}`.                      |
| `COMPUTER_RUNTIME`                   | Set to `runsc` to run supervised computers under gVisor.                                  |
| `COMPUTER_SANDBOX`                   | Set to `on` to enable Chromium's own sandbox where the host permits user namespaces. Which way it went is printed at start-up. |

`COMPUTER_SANDBOX` is not the cluster sandbox provider. A Kubernetes deployment can instead run each
computer as a sandboxed pod, selected by `COMPUTER_SANDBOX_NAMESPACE` with `COMPUTER_SANDBOX_IDLE_AFTER`
and `COMPUTER_SANDBOX_TEMPLATE_FILE` beside it; those are set by the Helm chart, not by Compose, and
are covered in [charts/openbot/README.md](../charts/openbot/README.md). The similarly named
`COMPUTER_SANDBOX` above only toggles Chromium's own process sandbox on a Docker computer.

Changing `COMPUTER_BROWSER_MODE` affects new supervised computers. A computer that already exists is
left running until its image changes or its container is recreated. To apply a mode-only change to
all computers while preserving their browser profiles and workspaces, apply the new supervisor
environment and remove only the owned containers (do not remove their volumes):

```sh
docker ps -aq --filter "label=openbot.namespace=openbot" | xargs -r docker rm -f
```

The supervisor recreates each computer with the same named volumes on its next request.

### Headed or headless managed Chromium in Docker or Helm

The managed backend uses Playwright's full `chromium` channel in either mode. The Docker image
already installs that browser and Xvfb; it does not require Google Chrome. Headed is the default in
Compose (`agent-computer` and the computers the supervisor creates) and in the Helm chart
(`computers.browserMode: headed`). The computer starts its own Xvfb, so nothing appears on any screen
and the live screen, take control and hand back work exactly as before. Headed costs a little more
memory and CPU than headless.

To run headless instead, set `COMPUTER_BROWSER_MODE=headless` for Compose and recreate the shared
computer or supervisor as applicable:

```sh
docker compose up -d --force-recreate agent-computer supervisor
```

Existing supervisor-created computers retain their mode until recreated as described above. The
same per-Bot profile volumes and streamed viewer continue to work. For Helm:

```yaml
computers:
  browserMode: headless
```

Apply the Helm upgrade. A newly created computer uses the new setting; recreate existing supervised
computers through your deployment's lifecycle controls while keeping their persistent volumes. A
headless computer no longer calls itself `HeadlessChrome`: its user agent and client hints report what
the same browser reports headed.

### Installed Chrome for a local API deployment

This source/deployment-checkout option launches a separate installed Google Chrome window for each
active Bot on macOS or Windows. The existing in-app viewer, browser tools, authentication, and Bot
access policy still apply. Linux uses a private Xvfb display and the viewer. This is not a packaged
desktop toggle or a bridge from a hosted API: the API must run on the same machine and reach the
helper through loopback.

Install [Bun](https://bun.com/docs/installation) and [Google Chrome](https://www.google.com/chrome/)
in its standard location, then install dependencies from the checkout root:

```sh
bun install --frozen-lockfile
bun install --cwd agent-computer --frozen-lockfile
```

Use the same existing `COMPUTER_TOKEN` for the API and helper. It can be set in the checkout's `.env`
(Bun loads it) or supplied securely in each process environment; the helper never prints it. Set the
following API configuration and clear both supervisor selectors, including any inherited process
environment values, because either selector takes precedence over the shared URL:

```dotenv
AGENT_COMPUTER_URL=http://127.0.0.1:4101
COMPUTER_SUPERVISOR_URL=
COMPUTER_SANDBOX_NAMESPACE=
```

In the helper's environment, leave `COMPUTER_BROWSER_BACKEND` and `COMPUTER_BROWSER_MODE` unset, or
set them to `local-chrome` and `headed`. An inherited `managed` or `headless` setting is an error.
Leave `PORT` unset for 4101, or explicitly choose another port and update the API URL to match. Start:

```sh
bun scripts/start-local-chrome-computer.ts
```

Restart the API with the configuration above. Open a Bot's computer and navigate to a website; its
dedicated Chrome window starts on first use. Use **Take control** in the app before interacting and
**Hand back** when finished. Closing a viewer does not close the Bot's browser or erase its logins.
The helper exits with an error for a missing token, a missing browser (neither Chrome nor Microsoft
Edge installed), or an occupied port instead of silently selecting another browser or port. With
only Edge installed it starts, and a person's own browser opens in Edge; a Bot's browser still
needs Chrome. Ctrl-C shuts down its computer process and browsers.

The helper ignores inherited `PROFILES_DIR` and `WORKSPACE_DIR`. Its defaults are:

- macOS: `~/Library/Application Support/OpenBot/local-computer`
- Windows: `%LOCALAPPDATA%\OpenBot\local-computer`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/openbot/local-computer`

Set `OPENBOT_LOCAL_COMPUTER_DIR` to an absolute, dedicated app-owned directory to change that root.
Do not point it at your personal Chrome data. Each Bot uses a separate persistent subdirectory under
`profiles/`; no existing Chrome session is attached, and no TCP debugging endpoint is exposed.
Native Chrome retains its process sandbox and OS credential store. File tools remain confined to
the helper's `workspace/`, and shell execution is refused: use OpenBot's separately approved host
access tools for host commands. Native Chrome runs with your OS account's network access; this mode
is not a container or an OS network sandbox. Keep the API's private-host browsing opt-in off unless
you intentionally need it for your local deployment.

To switch back, stop the helper, restore your prior `AGENT_COMPUTER_URL` and supervisor/sandbox
selectors, and restart the API. Unset `COMPUTER_BROWSER_BACKEND` (or set `managed`) on the managed
computer process; choose `headless` or `headed` as before. Local Chrome profiles remain in the local
data root, separate from managed computer volumes.

#### OpenBot Desktop runs it for the person

OpenBot Desktop starts this computer itself, as a fourth process beside the server, the app and the
worker, to run the person's own browser: their installed Google Chrome, or Microsoft Edge where
Chrome is missing, as a window on their desktop with the OpenBot Recorder already in it. Nothing
above needs doing. Desktop gives it a loopback port of its own (`BROWSER_PORT`, 4101 when free), the
computer token the stack already shares, the default data root above, and `OPENBOT_RECORDER_DIR`
pointing at the Recorder that installation copies into the deployment (`extension/dist`) out of the
release's own computer image, prebuilt, and `COMPUTER_PEOPLE_ONLY=on`. It points
the server at it with `OPENBOT_BROWSER_URL=http://127.0.0.1:<port>`. Bots' own computers stay with
the supervisor; only the person's browser runs here. It starts and stops with the rest of OpenBot,
is restarted the way the other processes are, and its browser is asked to close before Stop or Quit
takes the rest down (SIGTERM to the computer on macOS and Linux, `taskkill` without `/F` to the
browser's windows on Windows), and ended only if it has not closed within ten seconds.

It runs only when Chrome or Edge is installed where it looks (`/Applications` on macOS;
`Program Files` or the user's `AppData\Local` on Windows; on Linux `/opt/google/chrome` or
`/opt/microsoft/msedge`, where Google's and Microsoft's own packages put them on every distribution,
then `google-chrome-stable`, `google-chrome`, `microsoft-edge-stable` or `microsoft-edge` on the
`PATH`, as NixOS has them) and the deployment's release includes the OpenBot Browser. The Flatpak
builds of Chrome and Edge run sandboxed away from the profile and the Recorder and cannot be used,
and neither browser is published as a Snap. Otherwise `OPENBOT_BROWSER_URL` is not set, Desktop
sets `OPENBOT_BROWSER_ABSENT` to the reason, and the app says it to the person in one sentence.
Desktop checks again at every Start, so a browser installed later is found.

Uninstalling OpenBot Desktop removes the browser's data root (the profile the person signed in to)
and the Recorder's native messaging host manifests: the Windows uninstaller does, and so do the
.deb and .rpm packages' removal scripts, for each person and as that person. An app removed by
dragging it to the Trash on macOS, or an AppImage deleted, runs nothing on the way out, so there
those files stay until removed by hand. The helper above and
Desktop use the same data root, so stop one before starting the other: Chrome lets one browser at a
time use a profile.

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

Every computer runs its own filtering proxy on `127.0.0.1`, which applies the network policy an
administrator sets under **Admin > Enterprise controls**, and it sets `HTTP_PROXY`, `HTTPS_PROXY` and
`NO_PROXY` for itself and its shell to point at that filter. Do not set those three to reach an
upstream proxy; use `EGRESS_PROXY_<BOT_ID>` or `EGRESS_PROXY_DEFAULT`, which the filter chains to.

The server pushes each Bot's policy to its computer when the computer wakes and every 30 seconds
after. Until a policy has arrived, the filter refuses every connection. Metadata and link-local
addresses (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254` and the like) are refused in every mode,
including `allow_all`. `EGRESS_POLICY_REQUIRED=0` (or `false`) lets the filter allow everything
until a policy arrives instead, which only a computer run with no API server should need. It is read
by the computer: in Compose put it in `egress.env`, which reaches the shared computer, and on
Kubernetes put it in `computers.extraEnv`. The supervisor forwards only the `EGRESS_PROXY` names, so
a computer it creates does not receive it.

The supervisor also reads:

- `COMPUTER_IMAGE`
- `COMPUTER_NAMESPACE`
- `COMPUTER_NETWORK`
- `COMPUTER_MEMORY_BYTES`
- `DOCKER_SOCKET`

`ENGINE_SOCKET` is separate from those, because it is read by Compose rather than by the supervisor:
it is the host path mounted into the supervisor as `/var/run/docker.sock`. Unset, it is
`/var/run/docker.sock`, which is right for Docker and for Podman on macOS, where `podman machine`
symlinks that path to the rootless socket. Rootless Podman on Linux needs
`ENGINE_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`: there the default path is either missing or a
symlink to the rootful socket, which is not the one running, and the supervisor reports that it
cannot reach Docker.

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

### Getting past bot checks

Sites behind Cloudflare and similar services (ChatGPT, Canva and many more) decide on every request
whether it comes from a person, a known good bot, or something to challenge. A Bot's browser gives
them three answers, in order of how much each one is in the operator's hands, and then a fallback
for when none of them is enough.

1. **A real browser.** Headed Chromium, the default for hosted computers (see above). Headless
   Chromium is what bot checks are best at spotting, and is challenged even from a residential
   address.
2. **Web Bot Auth, off unless you switch it on.** The browser signs every request as coming from
   this deployment, the way OpenAI's agent does. A site that allows signed agents lets it through.
   See below.
3. **Where the traffic leaves from.** A datacenter address is the other thing bot checks key on. A
   residential or ISP proxy changes it. See [Residential or ISP proxy](#residential-or-isp-proxy).
4. **The handoff, which is the designed fallback.** When a site still challenges (a "Verify you are
   human" check, a CAPTCHA, a sign-in), the Bot asks for help, the person takes control in the live
   screen, solves it, and hands back. OpenBot never solves a challenge on anyone's behalf. The page
   survives a computer restart: the handoff reopens it rather than showing a blank browser.

#### Web Bot Auth

[Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) is
Cloudflare's signed-agent scheme, built on HTTP Message Signatures (RFC 9421). With it on:

- The server holds one Ed25519 key and publishes its public half, signed, at
  `<public URL>/.well-known/http-message-signatures-directory` (content type
  `application/http-message-signatures-directory+json`).
- Every request a Bot's browser sends carries `Signature-Agent: "<public URL>"`, plus `Signature-Input`
  and `Signature` over `@authority` and `signature-agent`, with `created`, a 60 second `expires`, a
  nonce, `tag="web-bot-auth"` and the key's JWK thumbprint as `keyid`. The headers are added inside
  the browser as each request leaves it, so the egress filter still judges every connection, TLS is
  still Chromium's own, cookies are unchanged, and no CORS preflight is added.

**When it is on.** Only when `WEB_BOT_AUTH=on` (on Helm, `config.webBotAuth: "on"`). Unset or `off`
means off, whatever the address. An OpenBot deployment is private by design, and signing announces
it: every site a Bot visits sees the deployment's URL, and Cloudflare will only register a key
directory it can fetch from the internet. So it is a deliberate choice, made by an operator whose
public URL is reachable and who wants sites to know their Bots. `on` needs `OPENBOT_PUBLIC_URL` (or
`BETTER_AUTH_URL`) to be https and not this machine, and is refused at start-up otherwise. A private
https address (`10.x`, `192.168.x`, `*.internal`, a single-label name) is accepted, because only the
operator knows whether their verifier reaches it.

**The key.** Derived from `KEY_ENCRYPTION_KEY` (one way, with HKDF), so every replica and restart
signs with the same key and nothing new is needed to start. `WEB_BOT_AUTH_KEY` names one instead, an
Ed25519 private JWK (on Helm, `secrets.webBotAuthKey`). The server hands it to each computer with
the network policy it already pushes, because the browser is what signs: a Bot's computer can sign as
this deployment, which is what it is for, and nothing else the deployment holds can be recovered from
it. Rotate by setting a new `WEB_BOT_AUTH_KEY` and registering again.

**Registering with Cloudflare (manual, once).** Signing earns nothing until Cloudflare knows the key:

1. Check the directory answers from the internet:
   `curl -i https://openbot.example.com/.well-known/http-message-signatures-directory` shows `200`,
   the content type above, `Signature` and `Signature-Input` headers, and one key.
2. In the [Cloudflare dashboard](https://dash.cloudflare.com/), choose your account, then
   **Manage Account** > **Configurations** > **Bot Submission Form**.
3. For **Verification Method**, choose **Request Signature**. For **Validation Instructions**, give
   the key directory URL from step 1. Submit.
4. Follow the request under **BotBase** > **Submission history**.

Until it is approved, signed requests are treated like any others. Other services that verify Web
Bot Auth read the same directory.

**What it tells sites.** Every site a Bot visits, Cloudflare-fronted or not, sees this deployment's
public URL in `Signature-Agent`. That is the point (an honest agent says who it is), and it is why
it is off unless switched on.

**What is signed.** Every request the browser sends, whatever sent it: pages, redirects,
subresources, cross-site frames running in processes of their own, dedicated workers, and service
workers, including their script fetches. The signing happens in one browser-level DevTools session,
so no kind of target can be missed by not being attached. The identity is per deployment, not per
Bot. The local Chrome backend never signs: it is the person's own browser.

#### Residential or ISP proxy

`EGRESS_PROXY_DEFAULT` (and `EGRESS_PROXY_<BOT_ID>`, see [Per-Bot egress](#per-bot-egress)) takes a
residential or ISP proxy's gateway URL, credentials included:

```sh
# egress.env
EGRESS_PROXY_DEFAULT=http://customer-user:password@gateway.residential.example:8000
```

On Helm, put the URL in a Secret and turn it on:

```yaml
computers:
  egressProxy:
    enabled: true
    # existingSecret: my-proxy        # or let the chart hold it in secrets.egressProxyUrl
    # existingSecretKey: egress-proxy-url
networkPolicy:
  computerExtraEgress:                # needed when networkPolicy.enabled
    - to: [{ ipBlock: { cidr: 0.0.0.0/0 } }]
      ports: [{ port: 8000, protocol: TCP }]
```

It reaches the shared computer and every per-Bot computer as `EGRESS_PROXY_DEFAULT`. The egress
filter chains to it, so the network policy still decides what a Bot may reach, and the proxy's
credentials are split out before Chromium or any status report sees them.

**This is the operator's choice, and it is off by default.** Through a residential proxy, a Bot's
traffic leaves from an address a consumer ISP owns, so a site sees what looks like a person at home
rather than a datacenter. That is why it works, and it is a choice to make knowingly: it changes
what the Bot appears to be, where Web Bot Auth says what it is. They can be used together.

## Attested identity

When optional SPIRE services are used:

- the supervisor reads `SPIRE_SOCKET`, `SPIRE_AGENT_ID`, `SPIRE_TRUST_DOMAIN`, and `SPIRE_AGENT_SOCKET_VOLUME`;
- computers read `SPIFFE_ENDPOINT_SOCKET`;
- Compose also uses `SPIRE_JOIN_TOKEN` and `COMPOSE_PROJECT_NAME`.

## Images

Every service `docker-compose.yml` can build is published by a release, so a machine can run the
stack without a toolchain and without waiting for Chromium to build.

| Service           | Setting             | Published image                            |
| ----------------- | ------------------- | ------------------------------------------ |
| `agent-computer`  | `COMPUTER_IMAGE`    | `ghcr.io/copilotkit/openbot-agent-computer` |
| `supervisor`      | `SUPERVISOR_IMAGE`  | `ghcr.io/copilotkit/openbot-supervisor`     |
| `agent-bot`       | `BOT_IMAGE`         | `ghcr.io/copilotkit/openbot-agent-bot`      |
| `agent-langgraph` | `LANGGRAPH_IMAGE`   | `ghcr.io/copilotkit/openbot-agent-langgraph`|
| `migrate`         | `SERVER_IMAGE`      | `ghcr.io/copilotkit/openbot-server`         |

Unset, each names a local tag and Compose builds it, which is what a checkout of this repository
does. Set to a published reference, pinned by digest, together with `IMAGE_PULL_POLICY=missing`,
Compose pulls instead. Both architectures are in every image, so the same reference works on an
arm64 laptop and an amd64 server.

`IMAGE_PULL_POLICY` is needed because a service carrying a `build` section builds by default
however its image is named. It is also not a promise that nothing is built: a pull that fails falls
back to building, which suits a developer and does not suit a machine with no toolchain, where the
useful answer is that the image could not be fetched. Somewhere that must never build, override the
`build` sections away instead.

`docs/releasing.md` shows reading the digests straight out of a release's `container-images.json`.

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

Set `OPENBOT_ONE_COMPUTER_EACH=false` when using `start.sh` to run everybody's Bots against one shared computer instead of one per person.

## Tenant package

The tenant package contains five required YAML files, and two optional:

```text
examples/fintech/
├── brand.yaml
├── agents.yaml
├── channels.yaml
├── model.yaml
├── knowledge.yaml
├── skills.yaml      (optional)
├── agents/          (optional, one coworker per file)
└── catalog/         (not loaded: coworkers to copy into agents/)
    └── expense-review.yaml
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
    endpoint: ${MANAGED_AGENT_AG_UI_URL:-}
```

Each agent requires `id`, `name`, `title`, `role_description`, and `type`.

| Type            | Required field  |
| --------------- | --------------- |
| `built-in`      | `system_prompt` |
| `remote-ag-ui`  | `endpoint`      |
| `remote-mastra` | `endpoint`, and optionally `remote_agent_id` to pick one agent on that Mastra server |

A remote agent whose `endpoint` resolves to an empty string is left out rather than refused, and it
is dropped from every channel's `permitted_agents` too. That is how the example package carries a row
for a Bot that only exists once something is configured.

An agent may list `skills:`, slugs of skills this package ships in `skills.yaml`. A slug the package
does not ship, or the same slug twice, stops the server. Two agents with the same `id` in
`agents.yaml` stop it as well.

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

### `agents/`

A coworker may also be one file of its own, in an `agents/` directory beside `agents.yaml`. Both are
read, and a package that keeps every coworker in `agents.yaml` is unchanged.

The shipped package starts with two coworkers, General Assistant and Knowledge, both in `agents.yaml`.
Its other two entries, Risk Analyst and the picked harness, register only when their endpoints are
configured. Ten more are in `catalog/`, which is not read. Copy one into `agents/` to add it:

```yaml
# examples/fintech/agents/expense-review.yaml, copied from catalog/
id: expense-review
name: Expense Review
title: Finance Operations
role_description: Check one expense claim at a time against the policy as it is written.
avatar_seed: expense-review
type: built-in
system_prompt: Quote the clause you relied on, and leave the decision to a person.
skills:
  - find-a-document
```

The file holds the coworker on its own, as above, or a list under `agents:` the way `agents.yaml`
does. Only `.yaml` and `.yml` are read, so a README beside them is left alone. Files are read in
filename order, and every check that applies to a row in `agents.yaml` applies here too: a refusal
names the file it came from.

Two files declaring the same `id`, or a file repeating an id `agents.yaml` already uses, stop the
server and both files are named. Nothing wins by being read later — which coworker a deployment runs
should not depend on what a directory listing happened to return.

The directory is in the package checksum, so adding, editing or deleting a coworker there is a
package change like any other and a running deployment notices it on the next boot.

**Deleting a file does not remove the Bot from a deployment that already registered it.** The next
boot stops declaring it, but its row stays, still owned by the package, so it is still listed and
still refused by delete as protected. Only a remote coworker whose `endpoint` is blank is retired
automatically. Retire one that is gone from the package by setting `deleted_at` on its
`agent_profiles` row, which is what delete does for a Bot somebody made.

### `channels.yaml`

```yaml
channels:
  - id: risk-and-compliance
    name: Risk & Compliance
    description: Investigate policies and controls.
    permitted_agents: [knowledge, risk-analyst]
    allowed_groups: [risk, compliance]
```

Each channel requires `id`, `name`, `description`, `permitted_agents`, and `allowed_groups`. Every `permitted_agents` entry must match an agent id. A channel `id` declared twice, or an agent listed twice in one channel, stops the server.

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

`provider` must be `openai` or `anthropic`. `credential_secret_ref` is a reference to a stored credential, not a credential value. `default_model` is passed through as written, so an OpenAI-compatible endpoint reached through `OPENAI_BASE_URL` takes the name that endpoint publishes.

At start-up the server asks OpenAI or Anthropic, once, whether the configured key can call `default_model`. A key that cannot (a project key whose model allowlist leaves it out, say) would otherwise fail at the first message; instead the log says `model-unavailable`, naming the model and the fix. A rejected key logs `model-credential-rejected`. Nothing is asked with no key configured yet, or of an endpoint set by `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, and start-up never waits for the answer.

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

One slug is load-bearing. A Bot granted `skill-creator` is offered the four tools that let a conversation end in a saved skill, so a package shipping that skill should also grant it to a Bot in `agents.yaml` — shipping it and granting it to nobody boots a deployment where writing a skill in the composer quietly does nothing. It declares no `tools`, and should not: those four are the app's own rather than a connector's, so they are not `serverId/toolName` refs. See [architecture.md](architecture.md#writing-a-skill-in-a-conversation).

Slugs are 2 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit, the same rule the skills API and the app's form apply. A slug declared twice in `skills.yaml` stops the server. If a package ships a slug somebody in the deployment already wrote a skill under, theirs keeps the name, the package loses that skill, and startup continues.

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
