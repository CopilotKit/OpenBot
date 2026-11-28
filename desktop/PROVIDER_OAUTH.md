# Model provider OAuth

OpenBot Desktop's xAI connection offers provider sign-in alongside an API key.
The sign-in leaves a refreshable session in a private credential file.

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
