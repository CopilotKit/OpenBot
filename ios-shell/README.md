# iOS web view shell (experiment)

A small native iOS app around one `WKWebView` showing the OpenBot web app (https://my.open.bot by
default). It is an experiment, not a product. The Expo app in `mobile/` is unchanged.

What is native:

- **The first screen.** "OpenBot", one line and Sign in. Drawn without the network. At launch the app
  looks for the web app's session cookie (`better-auth.session_token` or
  `__Secure-better-auth.session_token` on the base host) in the web view's cookie store: there, it
  goes straight to the tabs; not there, this screen.
- **Sign-in.** Sign in makes a PKCE pair and asks the server how to sign in:
  `GET /api/auth/shell/config?platform=ios` (no cookies, no redirects followed, 15 s;
  `HandoffConfig.swift` decides, strictly). No answer: the lock screen. 404, `{"handoff":false}` or
  anything unexpected: the web app's own sign-in, full screen in the web view
  (`/sign?native-sign-in=web`) with a Cancel bar. `{"handoff":true,"callback":"scheme",…}`: the
  system sign-in sheet (`ASWebAuthenticationSession`) opens `/api/auth/shell/handoff?challenge=…&platform=ios`
  and finishes on `openbotshell://signed-in?ticket=…` (the scheme is NOT registered in Info.plist:
  only the sheet the app started can take it). `{"handoff":true,"callback":"https","callbackUrl":
  "<base>/api/auth/shell/callback"}`: the same, finishing on that https address, which only this
  app can claim (iOS 17.4+, associated domains; below 17.4, or if the sheet cannot start, the web
  sign-in). The ticket and the verifier then go to `/api/auth/shell/enter` in the web view, which
  sets the session cookie there. While
  signed in, the hosted sign-in's renewal (`/api/auth/hosted/sign-in`) runs in the sheet the same
  way when the server has the hand-off.
- **The tab bar.** A UIKit `UITabBar` under the web view: Conversations, Home, Bots. A tap asks the
  page to navigate with the `openbot:open` event, and loads the page if nobody handled it. The page's
  `route` messages select the tab. The bar hides while the keyboard is up. The web view sits between
  the status bar and the tab bar; the strips around it take the page's background colour and its
  light or dark style.
- **The loading skeleton.** Whenever the web view is put on screen before its page has drawn (launch
  when signed in, the instant the sign-in sheet returns, the web sign-in's first load, a retry, a
  restarted web content process), a native skeleton (`loading-skeleton`, "Loading") covers the web
  view with a highlight sweeping left to right (a gentle pulse with Reduce Motion). It goes when the
  page says `ready`, or when a page without the bridge shows text (8 s at most), after at least 0.3 s;
  every new document on the web app's origin brings it back until it draws. It appears without a fade, so no frame shows an empty
  web view. Signing out is the web app's own: the app notices it from the `signed-out` message or
  from the URL reaching `/sign`, then deletes the two session cookies.
- **The lock screen.** No connection (`NWPathMonitor`), or the web app did not load (a failed
  main-frame load, 20 s without any answer from WebKit, or no answer to a sign-in step): one native
  screen, "Cannot reach the OpenBot backend", covers everything, with Try again and the support
  address. It retries by itself (every
  5 s, every 15 s after 6 tries, and when the network comes back) and lifts when a page loads. Its
  accessibility value says which case it is: `no-network` or `load-failed`.
- **The keyboard.** The web view's form-assistant bar (arrows and a check mark above the keyboard)
  is removed (`KeyboardAccessory.swift`, the react-native-webview technique, on WebKit's private
  content view: if a future iOS renames it, the bar simply comes back). While the keyboard is up the
  web view ends at its top edge, so the message box and Send stay above it. The keyboard goes away by
  dragging the page down or tapping outside a field: on a page that does not scroll (the web app
  turns overscroll off in the shell) a pan recognizer beside WebKit's ends editing after a mostly
  downward 40 pt drag that did not start in a field. The system sign-in sheet is Safari's view, so
  its bar stays there.
- **Orientation.** A phone stays in portrait; an iPad turns every way.
- **What the web view lets through.** `enter` is loaded with the header `OpenBot-Shell: ios` and
  never kept or loaded again (a retry or a restarted web process loads its `to`). Other schemes go
  to the system only from a tap in the main frame, and only `mailto:`, `tel:` and `sms:`. Another
  site's JavaScript dialogs are dropped; the web app's own are titled OpenBot. A file the page
  downloads goes to the share sheet, never in place of the page. A 5xx page on the web app's own
  origin is a load failure (the lock screen). Another site's page that fails (an identity provider
  blocked on this network) sends the web view back to the web app's last page instead of locking.
  Sign-out clears the site's data. Once a page has said `ready`, only its own `signed-out` or
  `route` end the session; without the bridge, reaching `/sign` ends it only if the session cookie
  is really gone.
- **The bridge.** The page gets `window.__OPENBOT_NATIVE_SHELL__ = {platform: "ios", version, bridge: 1}`
  at document start (main frame, own origin only) and posts `ready`, `route` and `signed-out` to
  `window.webkit.messageHandlers.openbotShell` (`app/src/lib/native-shell/`). When the page says
  nobody is signed in, the app deletes the two session cookies (and no others) and shows its own
  sign-in screen.

## Known gaps

- **Script navigations to other sites** load in the app's one web view with no address shown, and
  the web app's connect flows (an integration's OAuth page) are not adapted to the shell yet. A
  tapped link to another site opens in an in-app Safari sheet; a page that sends itself elsewhere by
  script does not. A bridge message for it is being assessed on the web side.
- **The hosted sign-in's renewal** follows the server's contract (backend `docs/shell-sign-in.md`,
  "Renewing the hosted sign-in"): the sheet opens `/api/auth/hosted/sign-in?returnTo=<hand-off>`
  and `enter` returns to the web app's `returnTo`. The mock has no hosted sign-in route, so this is
  proven by unit tests (`ShellURLsTests`, against the contract's worked example) only.
- **History after sign-out.** Sign-out clears the site's data (cookies, storage, caches); the web
  view's back-forward list stays, but while signed in back and forward never reach another site's
  page or the sign-in page.

## Before the App Store

- No app icon set (`ASSETCATALOG_COMPILER_APPICON_NAME` is empty in `project.yml`).
- `DEVELOPMENT_TEAM` is empty; the entitlements (associated domains for `my.open.bot`) do nothing in
  an unsigned build, and the association file on the domain needs the Team ID.
- `KeyboardAccessory.swift` swaps a private WebKit class at run time to hide the keyboard's
  form-assistant bar, which App Review may object to. `OpenBotHideKeyboardAccessory` in Info.plist
  (`project.yml`) set to false turns it off without a code change; the bar then comes back.
- A store build is plain Release: it reads nothing from its launch environment. Only DEBUG builds
  and the Release build CI tests with (`SWIFT_ACTIVE_COMPILATION_CONDITIONS=OPENBOT_TEST_ENVIRONMENT`
  on the xcodebuild command line) read `OPENBOT_BASE_URL`, `OPENBOT_SHELL_DIAGNOSTICS`,
  `OPENBOT_SHELL_TEST_NAME` and `OPENBOT_SHELL_EPHEMERAL_SIGN_IN`; CI builds the store
  configuration too and fails if any of those names is in its binary.

## Run it on a Mac

```sh
brew install xcodegen
cd ios-shell
xcodegen
open OpenBotShell.xcodeproj
```

Pick an iPhone simulator and press Run. No signing is needed for the simulator.

To point the app at another server, open Product > Scheme > Edit Scheme > Run > Arguments and turn
on `OPENBOT_BASE_URL` (it is there, switched off, set to the local probe). The default comes from
the `OpenBotBaseURL` key in Info.plist, which `project.yml` sets to `https://my.open.bot`.
`http://localhost` and `http://127.0.0.1` load too (`NSAllowsLocalNetworking`).

## Diagnostics

Turn on `OPENBOT_SHELL_DIAGNOSTICS=1` in the same place (the UI tests always do). The app then:

- injects a script into every frame that reports `console.error`/`console.warn`, uncaught errors,
  unhandled promise rejections, CSP violations, and every `fetch` and `XMLHttpRequest` (method,
  URL, status, failure, page origin vs request origin, mode, credentials). A cross-origin fetch
  that rejects with `TypeError` is flagged `likelyCORS`;
- records every navigation, its HTTP status and security headers, popups, permission requests and
  load errors;
- after each page load, and 5 seconds later, records a snapshot of the page: URL, title, user
  agent, cookie names, storage and API availability, viewport meta, size, `env(safe-area-inset-*)`
  values and the first 600 characters of visible text; plus the cookie jar's names and attributes.

Each record is one JSON line in `Documents/diagnostics.jsonl` in the app's container and is also
logged with the prefix `OPENBOT_DIAG `. Cookie values, query string values, tokens and request or
response bodies are never recorded.

On a simulator: `cat "$(xcrun simctl get_app_container booted ai.openbot.shell data)/Documents/diagnostics.jsonl"`.

## Associated domains (TODO: Team ID)

`OpenBotShell.entitlements` claims `webcredentials:my.open.bot` and `applinks:my.open.bot`, for the
hand-off's https callback. It takes effect only in a build signed with the team's provisioning
profile, with `DEVELOPMENT_TEAM` set in `project.yml` (still empty: a known TODO) and the
association file (`/.well-known/apple-app-site-association`, naming `<TeamID>.ai.openbot.shell`)
live on my.open.bot. CI builds unsigned, so the https callback cannot be proven here.

## Test hooks (DEBUG builds only)

Read from the launch environment in `ShellConfig.swift` inside `#if DEBUG`, so a release build
ignores them.

| Variable | Effect |
| --- | --- |
| `OPENBOT_SHELL_PLAIN_WEBVIEW=1` | Step 1's bare full-screen web view at `OPENBOT_BASE_URL` (path kept): no sign-in screen, no tabs. The probe tests use it. |
| `OPENBOT_SHELL_RESET=1` | Clears the web view's whole data store at launch. |
| `OPENBOT_SHELL_TEST_SESSION_COOKIE=<value>` | Sets `__Secure-better-auth.session_token` (Secure, HttpOnly, path /, base host) before the first load. |
| `OPENBOT_SHELL_TEST_STALE_SESSION=1` | Sets `better-auth.session_token=stale`: a session the server no longer knows. |
| `OPENBOT_SHELL_HANDOFF_AUTO=1` | Adds `&auto=1` to the hand-off URL (the mock then continues by itself). |
| `OPENBOT_SHELL_DEBUG_SHEET_URL=<url>` | Sign in opens that URL in an ephemeral sheet instead. |
| `OPENBOT_SHELL_FORCE_OFFLINE=1` | The offline lock, for good. |
| `OPENBOT_SHELL_FORCE_OFFLINE_SECONDS=<n>` | The offline lock for n seconds, then the real network. |
| `OPENBOT_SHELL_FORCE_DARK=1` | The whole app, web view included, in dark mode. |
| `OPENBOT_SHELL_DELAY_FIRST_LOAD_SECONDS=<n>` | Holds the first page load back n seconds when signed in (to see the skeleton). |
| `OPENBOT_SHELL_TEST_PLAIN_SESSION_COOKIE=<value>` | Sets `better-auth.session_token` (the http mock's name). |
| `OPENBOT_SHELL_TEST_KILL_CONTENT_SECONDS=<n>` | Kills the web content process n seconds after a signed-in launch (WebKit's private `_killWebContentProcess`). |

In DEBUG builds and the CI Release test build only (not in a store build): `OPENBOT_BASE_URL`,
`OPENBOT_SHELL_DIAGNOSTICS=1`, `OPENBOT_SHELL_TEST_NAME`, and `OPENBOT_SHELL_EPHEMERAL_SIGN_IN=1` (the
sign-in sheet shares nothing with Safari, and iOS asks no consent). DEBUG builds also draw an invisible `debug-state` label with the model's state for UI tests.

## The probe

`Probe/` is a static test page plus `serve.py`, a Python standard library server on two ports:
8765 plays the web app's origin and 8766 a different-origin API. The page checks cookies, CORS
(blocked, allowed with credentials, preflighted), a same-site cross-origin cookie, localStorage,
IndexedDB, server-sent events, a streaming fetch, the user agent, and shows a popup button, a
microphone button and a file input. `persist.html` checks that a cookie and a localStorage value
survive an app relaunch.

```sh
python3 ios-shell/Probe/serve.py
```

Then open http://127.0.0.1:8765/ in the shell (set `OPENBOT_BASE_URL`) or in any browser to
compare. The comment at the top of `serve.py` lists every endpoint.

## Release builds

A Release build has none of the hooks above (CI greps the binary for their names and fails if one is
there), no Web Inspector, and no App Transport Security exception: `NSAllowsLocalNetworking`, which
the probe and the http mocks need, is added to the built Info.plist by a Debug-only build phase
(`project.yml`). CI runs `RealBackendUITests` against a Release build, each test on a fresh install.
`PRODUCTION-PARITY.md` lists what the tests here do and do not prove about a shipped app.

## The mock stacks

The flow tests run against the real built web app over `app/workbench/mock-server.ts`:

```sh
bun install --frozen-lockfile && cp .env.example .env && (cd app && bun run build)
MOCK_SIGNED_OUT=1 SERVER_PORT=3001 bun app/workbench/mock-server.ts &   # MOCK_REPLY=1: a run answers one sentence
APP_PORT=3010 SERVER_PORT=3001 bun app/serve.ts &                      # A: with the hand-off
MOCK_NO_HANDOFF=1 MOCK_SIGNED_OUT=1 SERVER_PORT=3002 bun app/workbench/mock-server.ts &
APP_PORT=3011 SERVER_PORT=3002 bun app/serve.ts &                      # B: without it
```

## CI

`.github/workflows/ios-shell.yml` runs on pushes to `ios-webview-shell` that touch this folder,
and by hand (inputs: the two Google sign-ins, `real_backend_only`, and `device: ipad`, which runs
everything but the real-backend suites on an iPad simulator). It builds the web app, starts both mock stacks and the probe, boots an iPhone
simulator, builds once (`build-for-testing`) and runs the UI tests (`test-without-building`). It
uploads `ios-shell-shots-<run id>` (every screenshot as a small JPEG named `<test>--<moment>.jpg`,
the text attachments, `SUMMARY.md`, `diagnostics.jsonl`), `ios-shell-<run id>` (everything else)
and `ios-shell-video-<run id>`: a screen recording of `DemoTourUITests/testDemoTour`, a paced tour
of the app against mock stack A, run on its own after the main suite.

Recordings come from `.github/workflows/ios-shell-video.yml` ("iOS shell video", about 10
minutes): on every push it records the demo tour (public artifact `ios-shell-video-<run id>`) and
the real-backend journey on the session cookie (private `ios-shell-video-private-<run id>`), each
cut to its test and also as a 600-px copy. Started by hand with `real_google_sign_in`, the real
recording is a Release build signing in with Google in the web view (one prompt to the account's
phone per run).

Where the video workflow's time goes (each job has a 13-minute limit; the two jobs run side by side):

| Step | Warm cache | Cold (sources changed) |
| --- | --- | --- |
| Boot the simulator (in the background, during the rest) | about 20 s | about 20 s |
| Generate the Xcode project (cached XcodeGen binary) | about 35 s | about 35 s |
| Build the app and its UI tests (cached DerivedData) | about 45 s | 110 to 150 s |
| Web app (demo job; cached on its sources) | about 14 s | about 4 min |
| Record (demo tour / real journey) | about 2 min | about 2 min |
| Cut and make the 600-px copy | about 25 s | about 25 s |

The real-account tests (`testRealSignedInJourneyWithSessionCookie`, and the two Google sign-ins,
`testRealGoogleSignInInSystemSheet` and `testRealGoogleSignInInWebViewAndJourney`, which also need
their workflow input because each sends a prompt to the account's phone) run only when the
repository secrets `OPENBOT_SHELL_TEST_SESSION`, or `OPENBOT_SHELL_GOOGLE_EMAIL`,
`OPENBOT_SHELL_GOOGLE_PASSWORD` and `OPENBOT_SHELL_GOOGLE_TOTP_SECRET`, are set. Their screenshots, diagnostics and log lines go only to
`ios-shell-private-<run id>` (`ci/collect_shots.py`). Note: on a public repository Actions
artifacts can be downloaded by any signed-in GitHub user.
