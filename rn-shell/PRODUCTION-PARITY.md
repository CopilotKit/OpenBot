# What these tests prove about a shipped app

Every difference between the test setup here (CI on GitHub runners: an iPhone simulator on macOS, an
API 35 `google_apis` x86_64 emulator on Linux) and a signed store build on a real phone talking to
https://my.open.bot. The native shells' PRODUCTION-PARITY files cover the web view itself (WKWebView,
Android System WebView) in depth; this one adds what React Native changes.

- **Real backend**: tested against https://my.open.bot as deployed today.
- **Simulated**: tested here against something that stands in for production (how is said).
- **Not tested here**: why, and what would test it.

## Test build vs store build

| Difference | Status | Evidence or what would test it |
| --- | --- | --- |
| Which build the UI tests drive | Simulated | A **Release** build (iOS `-configuration Release`, Android `assembleRelease`, Hermes bytecode, minified JavaScript), made with `EXPO_PUBLIC_OPENBOT_TEST_BUILD=1`. That flag adds exactly three things: the test hooks in the JavaScript (`src/testHooks.ts`, read from launch arguments), http to localhost (iOS `NSAllowsLocalNetworking`, Android a network security config for localhost, 127.0.0.1 and 10.0.2.2) and web view debugging. Native code is the same in both builds: the local module reads launch arguments generically, but only the test build's JavaScript asks for them. |
| The store build has no hooks | Real build checks | `rn-shell-checks.yml`: the store JavaScript for iOS and Android contains none of the hooks' names (`openbot.base_url`, `openbot.test_session_cookie`, `launchArguments`, `debug-state`, `OPENBOT_DIAG`, …), checked on the minified bundles and on the Hermes bytecode inside the Android store APK; a control bundle made with the flag has them, so the grep would catch them. The store Info.plist has no App Transport Security exception and no URL scheme; the store APK's manifest refuses cleartext, has no network security config, is not debuggable, backup off. |
| Metro's cache and the test flag | Real build checks | `EXPO_PUBLIC_` values are inlined when Metro transforms a module and Metro keeps transformed modules between runs: a store bundle made after a test bundle on the same machine shipped the test hooks, even with `--reset-cache` under `CI=true`. CI builds each flavour on a fresh runner and the store check deletes Metro's cache before each bundle. A release machine must do the same. |
| Signing | Not tested here | iOS builds unsigned for the simulator; Android release builds are signed with the debug key (Expo's template). Associated domains and App Links need the real team and keys. |
| R8 / ProGuard | Not tested here | Off (Expo's default). The native Android shell runs R8. Turning it on needs keep rules and a re-run of the suite. |
| Over-the-air updates | Not applicable | `expo-updates` is not installed: the JavaScript is the one in the binary. |

## The app's behaviour

| Difference | Status | Evidence or what would test it |
| --- | --- | --- |
| Sign-in through the system sheet | Simulated | Flow `handoff-sign-in` on mock stack A: config, `/api/auth/shell/handoff` in `ASWebAuthenticationSession` (iOS, not ephemeral, after the system's consent alert) or a Chrome Custom Tab (Android, the link tapped), the ticket, then `enter` in the web view. Not deployed on my.open.bot (its config answers 404), so flow `real-first-screen-web-sign-in` takes the web sign-in fallback there: production's "Sign in to OpenBot Cloud", then the identity provider's page, and stops (no credentials). The hand-off is proven on the mock only. |
| The `OpenBot-Shell` header on `enter` | Simulated | The mock refuses `enter` without it, so landing on Home proves it was sent. Flow `header-probe` loads a probe the same way and records every request's header: present on the probe's `enter`, absent on a later same-origin page, on another origin and on the way back ("HEADER PROBE PASS"). |
| Shared Safari / Chrome sign-ins | Not tested here | The iOS sheet is not ephemeral (the code passes `preferEphemeralSession: false`), so it shares Safari's cookies; CI never signs in with Google (by rule). Test on TestFlight with Google already signed in in Safari. |
| The https callback (associated domains, App Links) | Not tested here | Coded (expo-web-browser's `preferUniversalLinks` on iOS 17.4+, the trampoline's App Link filter on Android, used only when Android reports the domain verified) and unit-tested in its decision; needs signed builds and the association files. |
| A foreign `openbotshell://` callback | Simulated (Android) | Flow `foreign-callback`: while the Custom Tab is open, two malformed callbacks are fired at the app; the trampoline drops them, the Custom Tab stays, and the real link still signs in. iOS registers no scheme at all (checked in the store Info.plist). |
| Signing out | Simulated | Flow `sign-out`: the web app's Account menu, the bridge's `signed-out`, the first screen; the site's cookies, storage and cache are deleted and the web view is thrown away. Never run with the real session secret (it would end that session). |
| Lock screen | Simulated, real network | Flows `lock-offline` (forced offline hook), `lock-recovers`, `lock-5xx` (a 502 server), `lock-silent` (a server that never answers: skeleton, then the lock at the 20 s watchdog) and, on a real network, `real-lock-unreachable` (an address that does not resolve). Airplane mode on a device is not driven. |
| Skeleton and no white frame | Simulated | Flow `skeleton` holds the first load back 6 s and sees the skeleton; every flow's screenshots show launch screen, first screen or skeleton, never a blank web view. Frame-by-frame proof is the demo recording. |
| Keyboard | Simulated | Flow `keyboard`: the software keyboard on the simulator and the emulator's Gboard; the tab bar hides, Send stays visible, a drag down closes it on Home, sending in a conversation keeps it, a tab tap closes it. Third-party keyboards and real-finger feel are not tested. |
| Web content process death | Simulated | Flow pair `process-death-*`: the page's process is killed from outside (iOS: the simulator's `com.apple.WebKit.WebContent` process with `pkill -9`, no private API; Android: the renderer's sandboxed process with `kill -9` as root) and the app comes back on the same page through the skeleton. A real kill under memory pressure is not reproduced. |
| Session survives a relaunch | Simulated | Flow `relaunch-signed-in` presses Home, then relaunches: straight to the tabs. Known limit (iOS): a cookie set seconds before a SIGKILL may not be on disk yet; not mirrored anywhere by design. |
| Cloudflare in front of production | Real backend | The real-backend flows mark themselves skipped, with a screenshot, if the bot check appears, and never try to get past it. |
| Dark mode | Simulated | Flow `dark`: the first screen and the lock screen in dark. |
| iPad, landscape | Not tested here | Phone only, portrait only (Info.plist and the Android manifest). |
| Push notifications, microphone, camera | Not tested here | Not implemented. |

## Real-device checks for the first internal build

1. Sign in with Google in the sheet / Custom Tab, use the three tabs, send a message, watch it stream.
2. Leave the app for an hour and overnight; open it: same page, socket back.
3. Airplane mode on and off; a Wi-Fi network with OpenBot reachable but no internet (VPC).
4. A cellular network and a corporate VPN: whether Cloudflare challenges the web view.
5. Kill the app 2 s after signing in (iOS): expect to sign in again at worst.
6. An iOS 17 device, a Samsung and a Xiaomi device, three-button navigation.
