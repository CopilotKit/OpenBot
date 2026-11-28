# What these tests prove about a shipped app

Every difference between the test setup in this folder (CI on a GitHub `ubuntu-latest` runner, an
Android emulator, API 35 `google_apis` x86_64) and a signed Play Store build on a real phone talking to
https://my.open.bot.

- **Real backend**: tested against https://my.open.bot as deployed today (suite 1 in SUMMARY.md).
- **Simulated**: tested here against something that stands in for production (how is said).
- **Not tested here**: why, and what would test it.

| Difference | Status | Evidence or what would test it |
| --- | --- | --- |
| Debug vs release build | Real backend, and simulated | `RealBackendReleaseTest` runs on **releaseTest**: R8-minified and resource-shrunk exactly like `release`, no hooks, not debuggable, https only. It differs from `release` in four ways, all for the tests: application id `ai.openbot.shell.releasetest`, the debug signing key, and three intent extras (base URL, diagnostics, test name; `TEST_OVERRIDES`). It is driven from outside its process (the debug build's instrumentation, through UiAutomator), on cleared app data per test. CI fails if a hook or test-override name is in the `release` APK's dex, if `addJavascriptInterface` is called, or if the release manifest is debuggable or allows cleartext (`ci/check_apk.sh`). The session-cookie journey, the hosted sign-in in a Custom Tab and the mock suite need debug hooks and say so. |
| http vs https, cleartext | Real backend | Release and releaseTest have a network security config with no cleartext at all. The debug build alone allows http to `localhost`, `127.0.0.1` and `10.0.2.2` (`src/debug/res/xml`), for the mocks and the probe reached through `adb reverse`. |
| Custom Tabs and the browser | Simulated (mock), real backend (partly) | The emulator image has Chrome 124.0.6367.219 (April 2024) as its only Custom Tabs browser; its first-run screens are turned off with Chrome's command-line file (root on `google_apis`) and any that still show are tapped away. Phones have a current Chrome, or Samsung Internet, Firefox, Edge or Brave as the default browser, each with its own Custom Tab and its own cookie jar: the hand-off works with any of them (it only needs the callback), but "shares the browser's sign-ins" means the default browser's. Without any Custom Tabs browser the app falls back to the web sign-in. |
| The hand-off's custom scheme | Simulated | Unlike iOS, Android must register `openbotshell://` (intent filter on `SignInCallbackActivity`). Any other app can register the same scheme; the app accepts a callback only while its own sign-in is pending, and the ticket is useless without the in-memory PKCE verifier. Chrome follows a tapped `openbotshell://` link to the app; it does not follow the mock's automatic (`auto=1`) redirect without a tap. |
| App Links (the https callback) | Not tested here | Coded (`autoVerify` filter for `https://my.open.bot/api/auth/shell/callback`; used only when `DomainVerificationManager` reports the domain verified, API 31+). Needs a release signed with the real key and `/.well-known/assetlinks.json` on my.open.bot naming its SHA-256 fingerprint (TODO). Test: an internal-testing Play build once the server ships the hand-off. |
| WebView version | Real backend (two versions) | The default emulator (API 35) has Android System WebView 124.0.6367.219, frozen in the image; the `api_level: 36` run (Android 16, run 46126178447, all green) has WebView and Chrome 133.0.6943.137. Phones update it through Play (current is far newer); old or unupdated devices (no Play services, some markets) can be much older. The bridge needs `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT` (WebView 86+, feature-checked; without them the user agent still marks the shell). |
| GPU drawing (the Bots "ghosting") | Emulator only | In recordings the Bots screen sometimes showed a faint second copy of its heading and rows. The page is clean: one `h1`, `scrollHeight` 628 equal to `innerHeight`, nothing duplicated in the DOM. Drawn in software (a canvas capture, and the WebView on a software layer) it is clean; drawn by the GPU compositor it ghosts, the same on API 35 (WebView 124.0.6367.219) and API 36 (WebView 133.0.6943.137). So it is the emulator's guest GPU renderer (`-gpu guest`), not the app or the page. The demo tour draws the Bots scene on a software layer for the recording only (debug hook `openbot.software_layer`); the app itself never does. Check on a real phone. |
| Cloudflare's bot check on my.open.bot | Real backend: seen, often | 403 `cf-mitigated: challenge` in the WebView, never in the Custom Tab. See the section below. |
| OEM differences | Not tested here | One Google emulator image. Samsung, Xiaomi and others ship their own launchers, keyboards, battery killers and sometimes their own WebView provider settings. Test on a Samsung and a Xiaomi device. |
| Edge to edge, insets, keyboard | Simulated | Target 36 forces edge to edge; the shell applies the insets itself, measured in CI on a 720×1600 screen at 320 dpi with gesture navigation (`testTabsRouteTheWebView`, `testKeyboardHidesTabBar`, the skeleton test). Three-button navigation, display cutouts of other shapes and foldables are not tested; a tablet size and rotation are (`HardeningTest`). On the emulator's guest GPU renderer, the resize when the keyboard closes on send leaves the web area blank (the page's background, no skeleton: it is not a new document) for about 0.5 s while the WebView redraws its tiles, and the bar comes back a moment later (demo run 46132747876, 47.6 to 48.2 s). Check on a phone. |
| Software keyboard | Simulated | The emulator's Gboard with the hardware keyboard off (`hw.keyboard=no`, `show_ime_with_hard_keyboard`). The demo types by tapping Gboard's keys (a grid laid over the keyboard window's bounds), falling back to `input text` (key events) when a key cannot be placed; the tests send text with `input text`. Samsung's keyboard and others are not tested. |
| Play Store requirements coded for | Real backend (build checks) | target API 36; edge to edge; predictive back (`enableOnBackInvokedCallback`, `OnBackPressedDispatcher`); `onReceivedSslError` always cancels; an origin-checked bridge with no `addJavascriptInterface`; file access off; Safe Browsing on; the photo picker for images instead of media permissions; no `POST_NOTIFICATIONS`; `allowBackup="false"` and backup rules excluding everything; microphone and camera asked at run time only when the page asks. Lint passes with no errors. Not proven: Play's pre-launch report and review. |
| Push notifications, FCM | Not tested here | Not implemented. |
| Microphone and camera | Not tested here | Granted only to the base origin after Android's runtime permission; the emulator has neither. Test dictation and a call on a device. |
| Background, Doze, the live socket | Simulated (mock), real backend | `testResumeFromBackground` and the journey send the app home for 40 s and check the page still routes. Doze, App Standby buckets and the cached-app freezer act after minutes to hours on a phone; the WebView's WebSocket is then closed and the web app must reconnect. Test overnight on a device. |
| Low-memory process death | Simulated (partly) | Each test runs in its own process; `…_2_relaunch` tests prove the cookie store survives a kill (the activity flushes it when it pauses). A sign-in pending while Android kills the process is dropped (the verifier is in memory only) and the person signs in again. The renderer's death (`onRenderProcessGone`) is coded, not provoked. |
| Play review | Not tested here | A WebView app needs native value; only a submission tells. |

## Cloudflare's bot check

my.open.bot is behind Cloudflare. From CI (a GitHub-hosted runner, a data-centre IP, an x86_64
emulator) the WebView very often gets Cloudflare's challenge instead of OpenBot:

- **What it is.** The main document answers **403** with `cf-mitigated: challenge` and
  `server: cloudflare`; the page is "Performing security verification … verifies you are not a bot"
  with a Turnstile "Verify you are human" checkbox. The app shows it (the skeleton ends 1.5 s after the
  page finishes without the bridge, or as soon as it has text; the watchdog stops at the commit, so the
  lock screen never covers it; the bottom bar stays). The tests stop there with a screenshot and never
  try to get past it.
- **How often.** In run 46122595057 every WebView load of my.open.bot was challenged: a first load in
  a fresh process, a reload, an in-process relaunch, a cold relaunch, the release-like build's web
  sign-in and the debug build's plain WebView; none cleared by itself within 45 s. In earlier runs it
  came and went: run 46106470979 was challenged on the first load, the Turnstile check cleared itself
  in about 20 s, `cf_clearance` (and `cf_chl_rc_ni`) were stored and flushed, and the cold relaunch
  was not challenged; run 46119389548's whole signed-in journey (message sent, reply streamed) ran
  unchallenged until its cold relaunch; runs 46105097597, 46108216848, 46109490937 and 46111171662 were
  challenged at the cold relaunch, one of them with `cf_clearance` still in the store. One challenge
  could not complete because a subresource on `challenges.cloudflare.com` failed with
  `ERR_ADDRESS_UNREACHABLE` inside the emulator.
- **Not our cookie handling.** The clearance cookie, when Cloudflare set it, was in CookieManager
  before the kill and after the relaunch (the activity flushes the store when it pauses).
- **The Custom Tab is not challenged.** In every run, the same address opened in Chrome's Custom Tab
  on the same emulator, minutes apart, showed OpenBot's page with no challenge. The difference is the
  client: Chrome 124's own user agent and network stack vs Android WebView 124.0.6367.219, whose user
  agent carries `; wv)` and `Version/4.0` (exactly: `Mozilla/5.0 (Linux; Android 15;
  sdk_gphone64_x86_64 Build/AE3A.240806.043; wv) AppleWebKit/537.36 (KHTML, like Gecko)
  Version/4.0 Chrome/124.0.6367.219 Mobile Safari/537.36 OpenBotShell-Android/0.1.0`). The user agent
  is not changed to get around it.
- **iOS never saw it** in any run (WKWebView's Safari-like user agent, a macOS runner).
- **What is not known.** Whether a phone on a home or mobile network sees it at all: a data-centre
  IP on an emulator is the kind of client bot protection distrusts most. Whether Cloudflare keys on
  the WebView's `; wv` mark, on the IP, or on the emulator's fingerprint, cannot be told apart from CI.
  What would settle it: the same build on a real phone on mobile data and home Wi-Fi, and Cloudflare's
  security events for the Ray IDs the screenshots show. If WebViews are challenged in the field, the
  fix is on the Cloudflare side (a rule that does not challenge the app, for example by its
  `OpenBotShell-Android` mark combined with a signed header), not in the app.

## The request headers of `enter`

`enter` is a native `loadUrl(url, headers)` (`WebController.loadEnter`), with the header
`OpenBot-Shell: android`. `ProbeTest#testEnterRequestHeaders` runs that exact code path against the
probe's header echo (`/api/echo-headers` on `127.0.0.1`, a trustworthy origin, so Chromium sends the
`Sec-Fetch-*` headers as it would to https), (a) from the signed-out first screen with nothing
loaded and (b) while a page is showing, as in a renewal:

| WebView | Case | Sec-Fetch-Site | Sec-Fetch-Mode | Sec-Fetch-Dest | Sec-Fetch-User | OpenBot-Shell |
| --- | --- | --- | --- | --- | --- | --- |
| 124.0.6367.219 (API 35, run 46144762894) | first screen | none | navigate | document | ?1 | android |
| 124.0.6367.219 (API 35, run 46144762894) | page showing | none | navigate | document | ?1 | android |
| 133.0.6943.137 (API 36, run 46144794643) | first screen | none | navigate | document | ?1 | android |
| 133.0.6943.137 (API 36, run 46144794643) | page showing | none | navigate | document | ?1 | android |

A native `loadUrl` is a browser-initiated navigation: `Sec-Fetch-Site: none` even with an OpenBot page
on screen. A page cannot produce that combination with a custom header (a page's navigation is
`same-origin` or `cross-site`, and a page's `fetch` with `OpenBot-Shell` is `Sec-Fetch-Mode: cors`).

## Real-device checklist

1. Install from an internal-testing track; sign in with Google in the Custom Tab (default browser),
   use all three tabs, send a message and watch the reply stream.
2. Leave the app for an hour and overnight; open it: the same page, the socket back.
3. Airplane mode on and off: the lock screen, then the app back by itself. Also on a Wi-Fi network
   without internet but with OpenBot reachable (a VPC): no lock.
4. On mobile data, home Wi-Fi and a corporate network or VPN: whether Cloudflare's check appears in the
   WebView, and whether it clears.
5. Dictation and a call: the microphone prompt names OpenBot and works.
6. A Samsung and a Xiaomi device, three-button navigation, a tablet, dark mode switched while open.
7. Do not open the app for 8 days, then open it: the native sign-in screen.
