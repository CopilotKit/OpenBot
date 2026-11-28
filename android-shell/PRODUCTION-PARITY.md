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
| Custom Tabs and the browser | Simulated (mock), real backend (partly) | The CI image originally had Chrome 124.0.6367.219. The local API 36 emulator ran Chrome 133.0.6943.137 as its Custom Tabs browser. In CI, its first-run screens are turned off with Chrome's command-line file (root on `google_apis`) and any that still show are tapped away. Phones have a current Chrome, or Samsung Internet, Firefox, Edge or Brave as the default browser, each with its own Custom Tab and its own cookie jar: the hand-off works with any of them (it only needs the callback), but "shares the browser's sign-ins" means the default browser's. Without any Custom Tabs browser the app falls back to the web sign-in. |
| The hand-off's custom scheme | Workbench and local self-hosted sign-in | On the API 36 emulator a fresh user signed in through a local Keycloak directory in the Custom Tab, confirmed the hand-off, returned to the app, and stayed signed in on cold relaunch.  Unlike iOS, Android must register `openbotshell://` (intent filter on `SignInCallbackActivity`). Any other app can register the same scheme; the app accepts a callback only while its own sign-in is pending, and the ticket is useless without the in-memory PKCE verifier. Chrome follows a tapped `openbotshell://` link to the app; it does not follow the mock's automatic (`auto=1`) redirect without a tap. |
| App Links (the https callback) | Not tested here | Coded (`autoVerify` filter for `https://my.open.bot/api/auth/shell/callback`; used only when `DomainVerificationManager` reports the domain verified, API 31+). Needs a release signed with the real key and `/.well-known/assetlinks.json` on my.open.bot naming its SHA-256 fingerprint (TODO). Test: an internal-testing Play build once the server ships the hand-off. |
| WebView version | Real backend (one version) | CI originally used Android System WebView 124.0.6367.219. The local API 36 image ran 133.0.6943.137. Phones update it through Play (current is far newer); old or unupdated devices (no Play services, some markets) can be much older. The bridge needs `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT` (WebView 86+, feature-checked; without them the user agent still marks the shell). |
| Cloudflare's bot check on my.open.bot | Real backend: seen | See the section below. |
| OEM differences | Not tested here | One Google emulator image. Samsung, Xiaomi and others ship their own launchers, keyboards, battery killers and sometimes their own WebView provider settings. Test on a Samsung and a Xiaomi device. |
| Edge to edge, insets, keyboard | Simulated | Target 36 forces edge to edge; the shell applies the insets itself, measured in CI on a 1080×2400 screen with gesture navigation (`testTabsRouteTheWebView`, `testKeyboardHidesTabBar`, the skeleton test). Three-button navigation, display cutouts of other shapes, foldables and tablets are not tested. |
| Software keyboard | Simulated | The emulator's Gboard with the hardware keyboard off (`hw.keyboard=no`, `show_ime_with_hard_keyboard`). Text is sent with `input text` while the keyboard is up (key events, not taps on keys). Samsung's keyboard and others are not tested. |
| Play Store requirements coded for | Real backend (build checks) | target API 36; edge to edge; predictive back (`enableOnBackInvokedCallback`, `OnBackPressedDispatcher`); `onReceivedSslError` always cancels; an origin-checked bridge with no `addJavascriptInterface`; file access off; Safe Browsing on; the photo picker for images instead of media permissions; no `POST_NOTIFICATIONS`; `allowBackup="false"` and backup rules excluding everything; microphone and camera asked at run time only when the page asks. Lint passes with no errors. Not proven: Play's pre-launch report and review. |
| Push notifications, FCM | Not tested here | Not implemented. |
| Microphone and camera | Not tested here | Granted only to the base origin after Android's runtime permission; the emulator has neither. Test dictation and a call on a device. |
| Background, Doze, the live socket | Simulated (mock), real backend | `testResumeFromBackground` and the journey send the app home for 40 s and check the page still routes. Doze, App Standby buckets and the cached-app freezer act after minutes to hours on a phone; the WebView's WebSocket is then closed and the web app must reconnect. Test overnight on a device. |
| Low-memory process death | Simulated (partly) | Each test runs in its own process; `…_2_relaunch` tests prove the cookie store survives a kill (the activity flushes it when it pauses). A sign-in pending while Android kills the process is dropped (the verifier is in memory only) and the person signs in again. The renderer's death (`onRenderProcessGone`) is coded, not provoked. |
| Play review | Not tested here | A WebView app needs native value; only a submission tells. |

## Cloudflare's bot check

On the local API 36 emulator, the release-like app reached Google and completed the password and authenticator steps. The hosted callback returned to the sign-in form. The app had no session on cold relaunch. This attempt saw no Cloudflare verification.

In [run 46122796578](https://github.com/CopilotKit/OpenBot/actions/runs/46122796578), the hosted web load and both session-cookie tests stopped at Cloudflare verification. The two fresh Google tests were disabled. Five pre-login and recovery tests passed. A physical device on a carrier network remains untested.

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
