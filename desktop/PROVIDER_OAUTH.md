# Model provider OAuth

OpenBot's xAI, Cloudflare and Unbiased AI model connections can sign in to the
provider. This is separate from signing in to OpenBot or CopilotKit. API keys
remain available for xAI and Unbiased AI; Cloudflare's row is its sign-in alone.
xAI's and Cloudflare's sign-ins leave a refreshable session in a private
credential file; Unbiased AI's mints an API key, which is kept like a typed one. The
ChatGPT and Claude plan sign-ins for OpenAI and Anthropic are a separate path
and are not covered here.

## Google Gemini

Gemini connects with an API key only, from Google AI Studio, at Google's
OpenAI-compatible address. There is no Google sign-in for Gemini.

OpenBot used to offer one. Every person's calls then ran on the one Google
Cloud project the build named for API quota, whose free tier refused most of
them, and a person outside that project needs a role on it before Google takes
the call at all. Google's own Gemini SDK also takes an API key, not a sign-in,
on the Gemini API.

A Google sign-in saved before this is never resumed. Desktop deletes its saved
tokens (`.openbot/model-oauth.json` when it holds a Google sign-in) at every
launch and keeps the choice, refuses it at Start, and its AI screen says "Google sign-in for Gemini has ended" with one
button, "Add a Gemini API key", that opens the Google Gemini row's API key.
The server lists a saved one with the problem `sign-in-retired` and refuses a
run on it; saving a Gemini API key on the same connection fixes it for every
Bot that used it.

Signing in to OpenBot itself with Google (`GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`) is a different thing, and is unchanged.

## xAI

xAI sign-in uses device authorization: OpenBot opens the provider's verification
page, the user approves the displayed code, and OpenBot receives refreshable
credentials. API calls use `https://api.x.ai/v1`.

The integration follows the public OAuth flow in xAI's endorsed OpenCode
integration. A distributor can set `OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID` to an
alternative registered client. Account entitlements and provider limits still
apply.

References: [xAI's OpenCode integration](https://x.ai/news/grok-opencode) and
[xAI OAuth discovery](https://auth.x.ai/.well-known/openid-configuration).

## Cloudflare

Cloudflare sign-in connects OpenBot to the person's own
[AI Gateway](https://developers.cloudflare.com/ai-gateway/). Model calls go to
`https://gateway.ai.cloudflare.com/v1/{account}/default/compat/chat/completions`
or, for a model that takes tools only on the Responses API (`openai/gpt-5.5`),
`.../default/compat/responses`. Both are on
the account's automatically created `default` gateway, and are billed to the
account's AI Gateway credits (Unified Billing). It is not a Cloudflare
subscription to a model: with no credits loaded, the gateway refuses the call. A
model is named as the gateway names it, `provider/model`, for example
`openai/gpt-5.5`, `anthropic/claude-sonnet-4-5` or a Workers AI model under
`workers-ai/`.

The flow is an authorization code with PKCE, the only flow Cloudflare offers a
third-party client: OpenBot opens the consent page on `dash.cloudflare.com`, the
person chooses **one** account and approves, and the browser returns to a
loopback address OpenBot listens on. OpenBot asks for three scopes:
`offline_access` (a refresh token), `aig.run` (send requests through AI Gateway)
and `account-settings.read` (read which account was chosen). A grant covering no
account, or more than one, is refused with what to do, because the gateway bills
exactly one. The session is sent to the gateway in `cf-aig-authorization`; the
account-level REST API does not accept it.

### Setting up the Cloudflare OAuth client

OpenBot Desktop carries the ID of OpenBot's own OAuth client
(`CLOUDFLARE_CLIENT_ID` in `src-tauri/src/provider_oauth.rs`), so a build signs
in with nothing to configure. The ID is not a secret: the client has none, and
the ID is in the address of every consent page. People who use OpenBot never
register anything; they only approve the consent page. These steps are for
replacing that client, or for a build that should use its own. In the Cloudflare
dashboard, under **Manage Account > OAuth clients**,
create a client. The form has three steps.

1. **Configure OAuth client.**
   - **Client Name**: what the consent page calls the app, for example
     `OpenBot`.
   - **Response Type**: **Code**.
   - **Grant type**: **Authorization Code** and **Refresh Token**. Without the
     second, Cloudflare issues no refresh token and OpenBot refuses the sign-in
     as one that cannot renew.
   - **Token Authentication Method**: **None (PKCE)**. The desktop app is a
     public client and ships no secret.
   - **Redirect (Callback) URLs**, all three, exactly:
     `http://127.0.0.1:47823/oauth/callback`,
     `http://127.0.0.1:47824/oauth/callback` and
     `http://127.0.0.1:47825/oauth/callback`. Cloudflare matches the redirect
     address exactly, port included, so OpenBot uses the first of these ports
     that is free. `localhost` is a different address and does not match.
   - Leave **Client URL** and everything under **Advanced options** empty for a
     private client.
2. **Select permission scopes.** The search matches the permission's name, not
   the scope's ID, so search `gateway` and `account settings`:
   - **AI & Machine Learning > AI Gateway**: **Run** only (`aig.run`). **Read**
     and **Edit** manage gateways and do not allow a model call. **Agents
     Gateway** is another product.
   - **Account & Billing > Account Settings**: **Read** only
     (`account-settings.read`).

   `offline_access` is not in the list; it comes with the Refresh Token grant.
3. **Choose optional scopes.** Leave both **Required**: OpenBot cannot work
   when either is declined.

**Create client** shows the client ID, which is not a secret.

A new client is private: only members of the account that owns it can authorize
it, and the consent page says the application has not verified ownership of any
domain. That is enough to test with. Making it public, so anyone with a
Cloudflare account can sign in, needs a logo, a client URL and a DNS `TXT`
record proving ownership of that URL's domain, and cannot be undone.

The account that signs in also needs AI Gateway credits (**AI > AI Gateway**,
Unified Billing). Without them the gateway answers 402 and OpenBot shows
Cloudflare's own sentence, "Insufficient unified billing credits".

To use another client than the built-in one, set
`OPENBOT_CLOUDFLARE_MODEL_OAUTH_CLIENT_ID` to its ID when building the desktop
app, or in the process environment at run time. For GitHub-built artifacts it is
a repository Actions **variable** of that name, passed to the native build.
Unset or empty, the build uses the built-in client.

`OPENBOT_CLOUDFLARE_DASHBOARD_URL` and `OPENBOT_CLOUDFLARE_API_URL` point the
flow at another dashboard and API for testing against a mock.

An account's administrator can turn off **Public OAuth App access**, which hides
that account on the consent page.

References: [Cloudflare OAuth clients](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
and [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

## Unbiased AI

Unbiased AI sign-in uses the platform's device authorization (RFC 8628): OpenBot asks
`https://platform.unbiased.ai` for a code, opens the approval page, and polls until
the person approves. The person signs in or creates an Unbiased AI account there, so
nobody needs an account before choosing the row. The platform then mints an API key
for `https://api.unbiased.ai/v1` exactly once and keeps no copy, so the token request
is never retried: a transport failure ends the sign-in and the person starts again.

The key is long-lived until revoked from the Unbiased AI dashboard and has no refresh
token, so it is not kept in the OAuth credential file above. It is carried into the
deployment exactly as a typed endpoint key is, as `OPENAI_API_KEY` against that base
URL, and saved in the protected store under the same endpoint-scoped entry. Bots run
the `pareto` model; the composer lists what the gateway's `/v1/models` publishes.

A distributor can set `OPENBOT_UNBIASED_OAUTH_CLIENT_ID` to an alternative client
registered with Unbiased AI. `OPENBOT_UNBIASED_PLATFORM_URL` points the flow at another
platform for testing against a mock; the approval URL must belong to that platform.

References: Unbiased AI's partner integration guide, which Unbiased AI shares with each
partner, and [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628).

## Other build-time settings

`VITE_OPENBOT_SUPPORT_URL` replaces the support link a startup failure offers. Unset, it points at
this repository's issues. A whitelabel build points it at its own support channel.

`VITE_OPENBOT_CLOUD_ENABLED=true` puts "OpenBot Cloud" on the first screen, first and picked, with
OpenBot for Business and connecting to an address under it, and OpenBot (Self-Contained) on a
smaller row that says what this computer needs. Unset, the first screen offers OpenBot
(Self-Contained) and OpenBot for Business (Cloud or Self-Hosted, either of which books a call), and
connecting to an OpenBot at an address.

Release and candidate installers have it on: `scripts/release-build.ts` is the release build
config, which `vite.config.ts` applies when `desktop-version.ts release` has run, as it does before
every release installer, unsigned or signed. Internal and pull request builds leave it unset. A
value in the build's environment wins, so `VITE_OPENBOT_CLOUD_ENABLED=false` turns it off in a
release build.

`VITE_OPENBOT_CLOUD_URL` is the OpenBot that "Sign in to OpenBot Cloud" on the first screen signs in
to: the address this app checks, posts its sign-in code to and calls the API on. Unset, it is
`https://api.open.bot`, OpenBot Cloud's address for programs, which is never challenged by bot
protection. A test build points it at a test stack, such as `https://cloud-test.example.com` or
`http://127.0.0.1:3001` (the shell takes `http` only on this computer's own address).

`VITE_OPENBOT_CLOUD_WEB_URL` is where people use that OpenBot in a browser: the address the first
screen names, and the one "Open in browser" opens. Unset, it is `https://my.open.bot`, or the
`VITE_OPENBOT_CLOUD_URL` a build sets on its own, since a test stack has one address for both.

Signing in to OpenBot Cloud opens the person's browser at `https://my.open.bot`, not at the address
this app calls. OpenBot Cloud's sign-in metadata, asked at `https://api.open.bot`, names its
authorization endpoint on `my.open.bot` (where the person may already be signed in, behind the bot
protection people's browsers get) and its token and revocation endpoints on `api.open.bot` (where
this app posts the code and refreshes, with no browser to answer a challenge). The shell follows an
authorization endpoint to another name under the same parent domain over https, and nowhere else;
the token and revocation endpoints must be on the address itself.

## Credential lifecycle

The desktop's provider credentials remain in its local deployment; React does
not receive access or refresh tokens. The local server refreshes credentials
before model calls and saves rotated tokens. Agent processes receive a local
proxy credential instead of the provider's refresh token. Provider revocation
requires signing in again.

Do not commit deployment credential files or include their contents in support
reports. OAuth validation must include a real model call, refresh and restart,
and a Bot using its browser tool and rendering a graphical component.
