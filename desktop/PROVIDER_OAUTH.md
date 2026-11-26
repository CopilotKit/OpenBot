# Model provider OAuth

OpenBot’s Google and xAI model connections are separate from signing in to OpenBot or
CopilotKit. Both providers support API keys and sign-in. Sign-in keeps a refreshable
session in a private credential file. ChatGPT and Claude plans use their own sign-in flows.

## Google Gemini

Google OAuth uses the Gemini Developer API and the selected Google Cloud
project's API quota. It does not use a personal Gemini subscription. OAuth
requests use Google's native generation API; the local server translates the
existing agents' Chat Completions requests, streamed replies, tool calls and
screenshots. API-key connections continue to use Google's compatibility API.

Before distributing a configured desktop build, register a **Desktop app** OAuth
client in a Google Cloud project with the Generative Language API enabled. Set
these variables when building the desktop app to include its defaults. Runtime
process environment variables can override those defaults:

- `OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID`: that desktop client's ID.
- `OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET`: the client secret, when issued.
- `OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT`: the project that supplies API quota.

For GitHub-built artifacts, configure repository Actions **variables** named
`OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID` and
`OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT`, plus an Actions **secret** named
`OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET` when the client has one. Every
workflow that builds the desktop app passes these settings to the native build:
Desktop build (which Desktop, Internal build and Publish release call) and
both signing workflows. They become defaults inside the distributed desktop app;
the desktop client credential is not a user access or refresh token.

When calling the Desktop workflow as a reusable workflow, pass its optional
`OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET` secret explicitly or use
`secrets: inherit`. GitHub does not provide repository secrets to fork pull
requests. Missing settings do not fail the build; API-key connections remain
available, and Google sign-in requires a configured build or runtime settings.

Do not reuse OpenBot's web SSO credentials (`GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`): their callback and permissions serve a different
purpose. Configure the consent screen and test users, and complete Google's
verification requirements before wider distribution.

References: [Gemini API OAuth](https://ai.google.dev/gemini-api/docs/oauth) and
[Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

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

## Unbiased AI

Unbiased AI stops serving models November 27, 2026 at noon EST. Use **Change AI
connection** in Desktop setup or **Settings → AI providers** to choose a replacement.
For an installation configured through its environment, update the provider’s endpoint,
model, and credential together. Your conversations stay with the installation.

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
