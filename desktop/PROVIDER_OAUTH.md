# Model provider OAuth

OpenBot's Google and xAI model connections are separate from signing in to
OpenBot or CopilotKit. API keys remain available for both providers.

## Google Gemini

Google OAuth uses the Gemini Developer API and the selected Google Cloud
project's API quota. It does not use a personal Gemini subscription.

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
`OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET` when the client has one. Both the
Desktop artifact workflow and the Windows signing workflow pass these settings
to the native build. They become defaults inside the distributed desktop app;
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

## Credential lifecycle

The desktop's provider credentials remain in its local deployment; React does
not receive access or refresh tokens. The local server refreshes credentials
before model calls and saves rotated tokens. Agent processes receive a local
proxy credential instead of the provider's refresh token. Provider revocation
requires signing in again.

Do not commit deployment credential files or include their contents in support
reports. OAuth validation must include a real model call, refresh and restart,
and a Bot using its browser tool and rendering a graphical component.
