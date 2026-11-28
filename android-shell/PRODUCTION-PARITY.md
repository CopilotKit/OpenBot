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
| WebView version | Local emulators | The API 36 workbench runs used WebView 133.0.6943.137. On API 26 with its factory WebView 58.0.3029.125, the native sign-in and offline screens worked. A module script did not execute. The workbench server issued the session cookie and received it on the redirected request, but the native cookie check saw none and sign-in timed out. Android 8 with an updated provider still needs testing. |
| Cloudflare's bot check on my.open.bot | Real backend: seen | See the section below. |
| OEM differences | Not tested here | One Google emulator image. Samsung, Xiaomi and others ship their own launchers, keyboards, battery killers and sometimes their own WebView provider settings. Test on a Samsung and a Xiaomi device. |
| Edge to edge, insets, keyboard | Simulated | Target 36 forces edge to edge; the shell applies the insets itself, measured in CI on a 1080×2400 screen with gesture navigation (`testTabsRouteTheWebView`, `testKeyboardHidesTabBar`, the skeleton test). A local API 36 Pixel Tablet emulator (2560×1600, 320 dpi) passed the tab geometry and keyboard tests with three-button system navigation. Its account menu also completed sign-out, cold relaunch and sign-in. Other display cutouts and foldables still need device coverage. |
| Software keyboard | Local emulators | With Gboard visible on a local API 36 handset, the demo sent Android key events to the focused composer, checked the entered text, tapped Send and waited for the reply. The Settings field and the composer have separate viewport checks. Other IMEs still need device coverage. |
| Play Store requirements coded for | Real backend (build checks) | target API 36; edge to edge; predictive back (`enableOnBackInvokedCallback`, `OnBackPressedDispatcher`); `onReceivedSslError` always cancels; an origin-checked bridge with no `addJavascriptInterface`; file access off; Safe Browsing on; the photo picker for images instead of media permissions; no `POST_NOTIFICATIONS`; `allowBackup="false"` and backup rules excluding everything; microphone and camera asked at run time only when the page asks. Lint passes with no errors. Not proven: Play's pre-launch report and review. |
| Push notifications, FCM | Not tested here | Not implemented. |
| Microphone and camera | Not tested here | Granted only to the base origin after Android's runtime permission; the emulator has neither. Test dictation and a call on a device. |
| Background, Doze, the live socket | Local emulator, workbench | On a Pixel 9, Chats survived separate one-hour and four-hour background intervals. A fresh socket opened 269 ms and 842 ms after the respective stale connections closed. A Pixel Tablet separately retained the page after five minutes of forced deep Doze. A handset on a carrier network still needs a physical-device test. |
| Process and renderer termination | Local emulators | The cold-relaunch tests exercise the Android process and persisted session. A separate test terminates the WebView renderer through Android’s API, waits for a replacement WebView, checks the exact open conversation, then opens Bots. Before the fix it returned to Home. A pending sign-in verifier is held in memory and the user restarts sign-in if Android ends the app process. A physical-device low-memory eviction remains untested. |
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

The Chats and Bots panel revision was built locally against the matching web draft. The deployed website has its own release schedule. Changes to the online destination require deployment of the web draft.
