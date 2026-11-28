# Android web view shell (experiment)

The Android twin of the iOS shell (branch `ios-webview-shell`): a small native app around one `android.webkit.WebView` showing the
OpenBot web app (https://my.open.bot by default). It is an experiment, not a product. The Expo app in
`mobile/` is unchanged. It speaks the same bridge and the same server contracts as the iOS shell
(`app/src/lib/native-shell/`, `app/workbench/mock-server.ts`), so a web build that works in one works
in the other.

Kotlin, one Gradle module (`app/`), Views (no Compose), AGP 9 with its built-in Kotlin, `minSdk` 26,
`compileSdk` and `targetSdk` 36, application id `ai.openbot.shell`, label "OpenBot".

What is native:

- **The first screen.** "OpenBot", one line and Sign in (`sign_in_button`). Drawn without the network.
  At launch the app looks for the web app's session cookie (`better-auth.session_token` or
  `__Secure-better-auth.session_token` on the base host) in the WebView's `CookieManager` (names only;
  values are never read into logs): there, it goes straight to the tabs; not there, this screen.
- **Sign-in.** Sign in makes a PKCE S256 pair in memory and asks the server how to sign in:
  `GET /api/auth/shell/config?platform=android` (`HttpURLConnection`: no cookies, no redirects, 15 s;
  `HandoffConfig.kt` decides, strictly, and is unit-tested). No answer: the lock screen. 404,
  `{"handoff":false}` or anything unexpected: the web app's own sign-in in the WebView, full screen
  without the bottom bar (`/sign?native-sign-in=web`) with a native Cancel bar. `{"handoff":true,
  "callback":"scheme",…}`: a **Chrome Custom Tab** (`androidx.browser`, Android's equivalent of the
  iOS system sheet, sharing the browser's sign-ins) opens `/api/auth/shell/handoff?challenge=…&platform=android`
  and finishes on `openbotshell://signed-in?ticket=…`. Unlike iOS, Android must register the scheme:
  `SignInCallbackActivity` (a translucent trampoline) has the intent filter, and passes the callback
  on only while a sign-in this app started is waiting (`PendingSignIn`, in memory; otherwise it is
  dropped). `"callback":"https"`: the same, finishing on `https://my.open.bot/api/auth/shell/callback`,
  claimed as an App Link (`android:autoVerify="true"`); the app uses it only when Android reports the
  domain verified (API 31+, `DomainVerificationManager`), else the web sign-in. The ticket and the
  verifier then go to `/api/auth/shell/enter` in the WebView, which sets the session cookie there;
  that one request carries the header `OpenBot-Shell: android`, which the server requires for it
  (login CSRF: a page cannot add the header, so it cannot plant a session in someone else's app). The
  enter address is never kept as the page to reload or logged. The trampoline passes a callback on
  only with a well-formed ticket for the pending sign-in's mode, so another app firing
  `openbotshell://` neither ends the sign-in nor closes the Custom Tab.
  Every step has a timeout and an error line on the native screen; closing the Custom Tab returns
  quietly. The hand-off path is `/api/auth/shell/handoff?challenge=<C>&platform=android&callback=<scheme|https>`
  (`ShellUrls.kt`, to the letter of the server's `docs/shell-sign-in.md`). The confirmation page's
  "Open the OpenBot app" link goes to the same callback address, so the trampoline takes it like the
  automatic return.
- **Renewing the hosted sign-in.** While signed in, a top-level navigation to exactly
  `/api/auth/hosted/sign-in` on the OpenBot host is stopped; its `returnTo` (decoded once; off-host or
  missing: "/") becomes `to`, kept in memory with a new PKCE pair; the Custom Tab opens
  `<host>/api/auth/hosted/sign-in?returnTo=<the hand-off path as one encoded value>`; the ticket that
  comes back goes to `enter` with the header and `to` encoded as one value (every character outside
  `A-Z a-z 0-9 - _ . ~` percent-encoded). Unit-tested against the doc's worked example
  (`ShellUrlsTest`); the mock has no hosted sign-in route, so there is no end-to-end test of it here.
- **The bottom bar.** A Material 3 `BottomNavigationView`: Conversations, Home, Bots (`tab_conversations`,
  `tab_home`, `tab_bots`; Home selected at start). A tap (also on the selected tab) asks the page to
  navigate with the `openbot:open` event and loads the page if nobody handled it. The page's `route`
  messages select the tab. One WebView for all tabs. The bar hides while the keyboard is up. The bar,
  the status bar and the navigation bar take the page's background colour and light or dark style.
- **Signing out.** The web app's own sign-out: the shell notices the bridge's `signed-out` message at
  once, and a landing on `/sign` (a `route` message, or the URL of a web app without the bridge)
  after a 2.5 s confirmation (still on `/sign`, or no session cookie: the web app's /sign sends a
  signed-in person on to "/"). Then the two session cookies, the origin's other cookies (except
  Cloudflare's `cf_*` clearance), its storage, the cache and the history go, and the native sign-in
  shows. After signing in the history is cleared, and Back never goes to another site's page, `/sign`
  or `/api/`.
- **The loading skeleton.** `LoadingSkeletonView` (`loading_skeleton`, "Loading") is the web area's
  default state: it covers the area (between the status bar and the bottom bar, which stays usable)
  from the instant the area is shown (cold launch with a session, the return from the Custom Tab before
  `enter` loads, the web sign-in, the lock lifting, a recreated WebView) and from the start of every
  full page load, until the page has rendered: 200 ms after the page's `ready`, or 1.5 s after the page
  finished without one (a web app without the bridge, or a bot check that must stay usable), never
  shorter than 300 ms. The WebView's own background is the app's or the page's colour, never white. Neutral shapes in
  surface-variant tones with a left-to-right highlight (1.3 s, linear); still when animations are off.
  It swallows taps while it shows, ends at the latest 10 s after the page commits, and a load failure
  hands it over to the lock screen. Every new document on the app's own origin brings it back until
  the page shows text (8 s at most).
- **The lock screen.** No network (`ConnectivityManager` default-network callback), or the web app
  did not load (a failed main-frame load, a 5xx main document, an SSL error, 20 s without a commit, or
  no answer to a sign-in step): one native screen covers everything (`offline_lock`), "Cannot reach the
  OpenBot backend", with Try again (`retry_button`) and `support@open.bot` (`support_email`, a
  `mailto:`). It retries by itself (every 5 s, every 15 s after 6 tries, and when the network comes
  back) and lifts when a page commits. A network Android has not *validated* does not lock the app by
  itself: a VPC-only deployment fails Google's connectivity check while OpenBot is reachable (see
  PRODUCTION-PARITY.md).
- **Edge to edge.** Target 36 draws behind the system bars; `ShellActivity.applyLayout` puts the
  status bar's inset above the content, the navigation bar's inside the bottom bar, and the keyboard's
  under the WebView while it is up, so the page's message box sits on the keyboard. System Back goes
  back in the WebView's history when it can, otherwise leaves the app (predictive back on,
  `OnBackPressedDispatcher`).
- **The bridge.** `WebViewCompat.addDocumentStartJavaScript` injects
  `window.__OPENBOT_NATIVE_SHELL__ = {platform: "android", version, bridge: 1}` on the base origin only;
  `WebViewCompat.addWebMessageListener("OpenBotShellAndroid", {base origin})` gives the page
  `OpenBotShellAndroid.postMessage(json)`, which `bridge.ts` calls; messages are accepted from the
  main frame on the base origin only. No `addJavascriptInterface`. The user agent ends with
  ` OpenBotShell-Android/<version>`.
- **Only the app's own origin locks the app.** A page of another site that fails to load (the
  identity provider, a link) sends the WebView back to the last page of the app; retries load the last
  page of the app, never another site's.
- **The WebView's rules.** JavaScript and DOM storage on; persistent cookies, flushed when the app
  pauses; file and content access off; Safe Browsing on; mixed content never; `onReceivedSslError`
  always cancels. Links to other sites open in a Custom Tab; `intent://` goes to an app only when safe
  (parsed with `Intent.parseUri`, component and selector removed, browsable only, from a tap); `mailto:`
  and `tel:` to the system. File inputs use the photo picker for images and the document picker
  otherwise (no media permission). `window.open` goes through a throwaway WebView that catches the
  address: the app's own pages load in the one WebView, other sites in a Custom Tab, a blank window is
  dropped (the app's page stays). JavaScript dialogs show only for the app's own pages, titled
  OpenBot. Downloads: http(s) go to the system's DownloadManager with the page's cookies; `blob:` and
  `data:` downloads cannot be handed over and are declined with a message. The microphone and camera are granted only to the base origin,
  after Android's own runtime permission. A dead renderer (`onRenderProcessGone`) gets a new WebView
  and a reload.

## Build and run

```sh
cd android-shell
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug             # on a connected device or emulator
```

Android Studio opens `android-shell/` as a project. The debug build points at my.open.bot; a test
extra points it elsewhere (below).

### Build variants

| Variant | What it is |
| --- | --- |
| `debug` | Debuggable, not minified, the test hooks (`src/debug`), cleartext http allowed only to `localhost`, `127.0.0.1` and `10.0.2.2` (`src/debug/res/xml/network_security_config.xml`). |
| `release` | Minified and shrunk by R8, no hooks (`src/release/.../DebugHooks.kt` is a no-op), https only, base URL from `BuildConfig.BASE_URL` and nothing else. CI fails if a hook or test-override name is in its dex (`ci/check_apk.sh`). |
| `releaseTest` | `initWith(release)`: minified and shrunk the same way, no hooks, https only, not debuggable. Four differences, all for the tests: application id `ai.openbot.shell.releasetest` (so it installs beside the debug build that drives it), the debug signing key, and `TEST_OVERRIDES`, which lets three intent extras set the base URL, turn diagnostics on and name the test. |

## Test hooks (debug builds only)

Intent extras (strings), read in `src/debug/java/ai/openbot/shell/DebugHooks.kt`:

| Extra | Effect |
| --- | --- |
| `openbot.plain_webview=1` | The bare full-screen WebView at the base URL (path kept): no sign-in screen, no tabs. The probe tests use it. |
| `openbot.reset=1` | Clears cookies, storage and cache before anything loads. |
| `openbot.test_session_cookie=V` | Sets `__Secure-better-auth.session_token=V` (Secure, HttpOnly, path /) for an https base. |
| `openbot.stale_session=1` | Sets `better-auth.session_token=stale`: a session the server no longer knows. |
| `openbot.handoff_auto=1` | Adds `&auto=1` to the hand-off URL. (Chrome does not follow the mock's automatic redirect to a custom scheme without a tap; the tests tap the link.) |
| `openbot.force_offline=1` / `openbot.force_offline_seconds=N` | The offline lock, for good or for N seconds. |
| `openbot.force_dark=1` | The whole app, WebView included, in dark mode. |
| `openbot.debug_tab_url=URL` | Sign in opens URL in a Custom Tab instead. |
| `openbot.delay_first_load_ms=N` | The first page load starts N ms late, so the loading skeleton can be seen. |

Debug and releaseTest (`TEST_OVERRIDES`): `openbot.base_url`, `openbot.diagnostics=1`, `openbot.test_name`.
Debug builds also draw an invisible view whose content description starts `debug-state` with the
shell's state, for the tests.

```sh
adb shell am start -n ai.openbot.shell/.ShellActivity \
  --es openbot.base_url http://localhost:3010 --es openbot.diagnostics 1
```

## The probe

`probe/` is a static test page plus `serve.py` (Python standard library) on two ports: 8765 plays
the app's origin and 8766 a different-origin API. It checks cookies, CORS, a same-site cookie,
localStorage, IndexedDB, server-sent events, a streaming fetch, WebSockets and the user agent;
`persist.html` checks that a cookie and a localStorage value survive a cold relaunch. `ProbeTest`
runs it in the debug build's plain mode.

## Diagnostics

With `openbot.diagnostics=1` the app writes JSON lines to `files/diagnostics.jsonl` and logcat (tag
`OPENBOT_DIAG`): launch (WebView package and version, user agent), state changes, sign-in phases and
the hand-off config answer, Custom Tab openings, bridge message types, navigations with redacted URLs
(query parameter names only), main-frame responses and errors, cookie names (CookieManager gives no
attributes), and an injected page script's console errors, failed fetches and XHRs, WebSockets and CSP
violations, plus a page snapshot after each load. Never tickets, verifiers, cookie values or query
values. `adb logcat -s OPENBOT_DIAG`, or `adb shell run-as ai.openbot.shell cat files/diagnostics.jsonl`.

## App Links (TODO: signing certificate)

The https callback needs `https://my.open.bot/.well-known/assetlinks.json` naming `ai.openbot.shell`
and the SHA-256 fingerprint of the release signing certificate (Play App Signing's, once there is one).
Until then Android does not verify the domain, the app sees that (API 31+) and uses the web sign-in
instead of the https callback. Not testable in CI.

## CI

`.github/workflows/android-shell.yml` (pushes to `android-webview-shell` touching this folder, and by
hand with `google_sign_in` and `real_backend_only`): builds debug, releaseTest and release, runs lint
and the JVM unit tests, checks what ships, builds this branch's web app and starts the mock stacks
(A with the hand-off on 3010, B without on 3011), the probe site (`probe/`, copied from the iOS shell's, on 8765/8766) and a silent server
(8797), boots an API 35 `google_apis` x86_64 emulator (KVM, software keyboard on, animations off,
Chrome's first-run screens off through its command-line file), reaches the servers through
`adb reverse` as `localhost`, and runs the instrumented tests one `am instrument` call per test
(`ci/run_tests.py`; a test named `…_2_relaunch` is a cold relaunch in a new process). Artifacts:
`android-shell-<run id>` (SUMMARY.md, results.json, diagnostics, filtered logcat, screenshots under
`shots/`, lint reports) and `android-shell-private-<run id>` (anything from a test with a real account).

`.github/workflows/android-shell-video.yml` makes the recordings apart from the tests (`which`:
demo, real, both; `real_google_sign_in`), each trimmed to the test's own marks with a 600-px copy:
`android-shell-video-<run id>` (`video/demo-tour.mp4`) and `android-shell-video-private-<run id>`.

The tests: `ShellFlowTest` (suite 2, mock stacks), `RealBackendReleaseTest` (suite 1 on the
releaseTest build, driven from the debug build's process through UiAutomator only),
`RealBackendDebugTest` (suite 1 with debug hooks), `ProbeTest` (web view basics), `DemoTourTest`
(the demo). UiAutomator throughout (native views, the WebView's accessibility tree, Chrome, system UI);
debug tests also read the page with JavaScript through the app's own WebView. Screenshots through
`screencap`, named `<test>--<moment>.png`.

On a public repository Actions artifacts can be downloaded by any signed-in GitHub user.

## Known gaps and release tasks

- **Release signing.** There is no release signing config: `release` builds unsigned. A Play upload
  needs an upload key and Play App Signing; then `/.well-known/assetlinks.json` on my.open.bot must
  name `ai.openbot.shell` and the app signing certificate's SHA-256 fingerprint (TODO) for the https
  callback.
- **Other sites inside the WebView.** A script navigation (not a tap) to another site loads inside
  the WebView with no address shown; the web sign-in fallback runs the identity provider there, and
  Google may refuse its OAuth inside a WebView (`disallowed_useragent`). The hand-off (Custom Tab) is
  the design that avoids both; the fallback stays for servers without it.
- **Renewal of the hosted sign-in** is unit-tested only (the mock has no hosted sign-in).
- **Cloudflare's bot check** on my.open.bot appears in the WebView from CI (see PRODUCTION-PARITY.md);
  the app shows it, never covers it, and never tries to get past it.

