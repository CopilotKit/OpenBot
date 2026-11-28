# React Native web view shell (experiment)

The third version of the phone app's shell, after `ios-shell/` (Swift) and `android-shell/` (Kotlin):
one codebase for iOS and Android, in React Native with Expo, around one web view showing the OpenBot
web app (https://my.open.bot). It is an experiment. `mobile/` (the team's Expo app) is unchanged.

It is on the team's stack and versions (`mobile/package.json`): Expo SDK 55, React Native 0.83,
React 19.2, TypeScript strict, npm with `package-lock.json`. No Expo Router (one screen), no
`expo-updates` (no over-the-air updates), no dev client: CI builds Release builds only.

## What it does

Everything the two native shells do (their READMEs and PRODUCTION-PARITY files are the spec):

- **First screen.** The mark, "OpenBot", one line and Sign in, drawn without the network. The launch
  screen shows the mark on the same background, then the first screen (or, with a session, the
  skeleton): never a blank or white frame.
- **Sign-in.** Sign in makes a PKCE S256 pair (expo-crypto), asks `GET /api/auth/shell/config?platform=`
  (no cookies, 15 s) and decides strictly (`src/logic/handoffConfig.ts`). No answer: the lock screen.
  404, `{"handoff":false}` or anything odd: the web app's own sign-in in the web view with a native
  Cancel bar. Otherwise the **system sheet** opens `/api/auth/shell/handoff?challenge=…&platform=…&callback=…`:
  iOS `ASWebAuthenticationSession` through `expo-web-browser`'s `openAuthSessionAsync`, NOT ephemeral
  (it shares Safari's Google session), with no URL scheme registered at all; Android a Chrome Custom
  Tab (`openBrowserAsync`), the callback arriving on a translucent trampoline activity that passes on
  only a well-formed ticket while a sign-in is pending. The ticket and the verifier then go to
  `/api/auth/shell/enter` in the web view with the header `OpenBot-Shell: ios|android`
  (react-native-webview's `source={{uri, headers}}`, on that one request; proven by the header probe
  test). The hosted sign-in's renewal (`/api/auth/hosted/sign-in` while signed in) runs in the sheet
  too and comes back to its `returnTo` (unit-tested against the contract's worked example).
- **Tab bar.** Chats, Home, Bots (the bridge's id for the first is still `conversations`), under the
  one web view. A tap, also on the tab already selected, dispatches `openbot:open` with the tab's root
  path (the page decides: switch to that tab where it was left, or pop to its root); the page's
  `route` messages select the tab. It stays in a conversation and hides only while the keyboard is up.
- **Back.** When the page's `route` carries `canGoBack` (the web app's per-tab stacks), Back is a
  command to the page: Android's Back closes the keyboard, sends `openbot:back` while the tab is deeper
  than its root, and leaves the app at a root; on iOS WebKit's back swipe is turned off and a swipe
  from the left edge sends `openbot:back`. Without `canGoBack` (production today) Android's Back walks
  the web view's history and iOS keeps WebKit's swipe; neither reaches /sign, /api/ or another site
  after sign-in (a new web view per sign-in, and the navigation policy refuses such back navigations).
- **Bridge.** At document start, in the main frame of the app's own origin only, the page gets
  `window.__OPENBOT_NATIVE_SHELL__ = {platform, version, bridge: 1}` and `window.OpenBotShellAndroid`,
  which the web app's `bridge.ts` already uses (on iOS too: it falls back to it). The user agent ends
  with `OpenBotShell-iOS/<v>` or `OpenBotShell-Android/<v>`.
- **Skeleton.** A native shimmer over app-like shapes covers the web view from the instant it is put on
  screen until the page has drawn text (`ready` plus text in `<main>`, or text without the bridge),
  swallows touches, and gives way to the lock screen at a 20 s watchdog.
- **Lock screen.** No network, or a failed main-frame load of the app's own origin (a 5xx too): the
  native screen with the exact copy, Try again and `support@open.bot`. It retries by itself (5 s, then
  15 s) and lifts when a page commits. Another site's failure goes back to the app's last page.
- **Sign-out** is the web app's own: the bridge's `signed-out` returns to the first screen, deletes
  the site's cookies, storage and cache, and throws the web view (and its history) away.
- **Keyboard.** The web view ends at the keyboard's top edge, the tab bar hides and comes back with no
  gap, a 40 px downward drag puts it away (on any page), tab taps, sign-out, the lock screen and the
  background put it away, sending keeps it. iOS's accessory bar is removed (`hideKeyboardAccessoryView`).
- **Portrait** on phones; iPad is not a target here (`supportsTablet: false`).

## Architecture in one page

```
index.ts → src/ui/App.tsx            the screen: web view, skeleton, tab bar, first screen, lock screen
           src/ui/useShell.ts        runs the machine: platform callbacks in, effects out (the only side effects)
           src/logic/machine.ts      PURE reducer: (state, event) → (state, effects); every rule lives here
           src/logic/handoffConfig.ts, urls.ts, pkce.ts, bridge.ts, injected.ts   PURE helpers
           src/config.ts, src/testHooks.ts   base URL; test hooks only in a test build
modules/shell-native/                 local Expo module (Swift + Kotlin): cookie store (names only), site
                                      data clearing, cookie flush, keyboard dismissal, launch arguments,
                                      https-callback support, Android's sign-in callback trampoline
patches/react-native-webview+…patch   JavaScript dialogs titled OpenBot and main frame only (both
                                      platforms); Android navigations tell their frame and gesture, and
                                      fail closed for non-http(s) when JavaScript does not answer in time
plugins/withOpenBotShell.js           config plugin: no URL scheme, portrait only, ATS and cleartext
                                      (test build: localhost only; store build: none)
app.config.ts                         Expo config; EXPO_PUBLIC_OPENBOT_TEST_BUILD=1 makes a test build
```

The web view exists only while it is shown, so each sign-in starts with a fresh web view (no history to
walk back through), and a dead web content process, a retry or a web sign-in that finished is a new web
view at the last own-origin page. All the navigation policy is one synchronous function
(`decideNavigation`), fed by react-native-webview's `onShouldStartLoadWithRequest`.

The bridge is guarded twice: react-native-webview's message channel is open to every frame, so a
message counts only with this launch's random token (known only to the script in the main frame of the
own origin) and only from the own origin.

## Build and run

`ios/` and `android/` are generated (continuous native generation) and not committed.

```sh
cd rn-shell
npm ci                                   # applies patches/ (postinstall)
npm run typecheck && npm test            # tsc strict; bun test for the pure logic (53 cases)
npx expo prebuild                        # store build: https://my.open.bot, no hooks
EXPO_PUBLIC_OPENBOT_TEST_BUILD=1 npx expo prebuild --clean   # test build (hooks, localhost)
npx expo run:ios --configuration Release        # on a Mac with Xcode
npx expo run:android --variant release          # with the Android SDK
```

A test build reads its launch arguments (iOS `-openbot.base_url http://localhost:3010`, Android intent
extras such as `--es openbot.base_url …`): `openbot.base_url`, `reset`, `test_session_cookie`,
`plain_session_cookie`, `stale_session`, `handoff_auto`, `force_offline`, `force_offline_seconds`,
`delay_first_load_ms`, `probe_url`, `force_dark`, `test_name`. A store build has none of these names
in its JavaScript (CI greps it), never reads its launch arguments, and has no localhost exception.

Clear Metro's cache between a test build and a store build on the same machine
(`rm -rf $TMPDIR/metro-*`): `EXPO_PUBLIC_` values are inlined when a module is transformed, and a
store bundle made after a test bundle reused the test build's modules (see COMPARISON.md).

## Tests and CI

- **Unit tests** (`__tests__/`, bun): the machine's flows (sign-in, renewal, sign-out, lock, skeleton,
  keyboard effects, process death), the navigation policy, URL building against the contract's worked
  example, PKCE against RFC 7636, the hand-off config, the bridge's checks.
- **Maestro flows** (`maestro/`): `flows/` against the mock stacks of this branch's built web app
  (first screen, hand-off sign-in through the system sheet, tabs, keyboard on Home and in a
  conversation, relaunch, sign-out, web sign-in fallback, skeleton, lock offline / recovering / 5xx /
  silent server, stale session, the header probe, web content process death, dark mode, and on Android
  a foreign `openbotshell://` callback), `real/` against https://my.open.bot (first screen, the web
  sign-in to the identity provider's page, lock when unreachable, the signed-in journey on
  `OPENBOT_SHELL_TEST_SESSION`), `demo/` for the recording. Flows that need a signed-in app start
  from cleared data and the mock's session cookie, so one failing sign-in does not fail the rest.
  `ci/run_flows.py` runs them one by one and writes `SUMMARY.md`, `results-*.json` and `shots/`.
- **Workflows**: `.github/workflows/rn-shell-ios.yml` (macOS: one build job, then 2 simulator test
  shards side by side), `rn-shell-android.yml` (Linux, KVM: 2 emulator shards, guest GPU),
  `rn-shell-checks.yml` (unit tests, the store configuration and store bundles, the Android store APK
  and its size), `rn-shell-video.yml` (the demo recordings, when the demo flow changes). The built
  app and APK are cached on their sources (git's index), so a change to flows or CI does not rebuild;
  a newer push waits for a running iOS workflow rather than cancelling its 15-minute build. Each
  flow has a deadline (2 to 3 minutes) and each shard's suite 15 minutes; a flow runs once more only
  when Maestro's own driver died. Each run uploads SUMMARY.md, results and screenshots per shard.

## Status (28 Nov 2026)

- Android: 18 of 19 mock flows and 2 of 3 real-backend flows pass (run 46149889717); the real web
  sign-in is skipped when Cloudflare challenges the emulator. Demo recording: run 46149889725.
- iOS: builds; first screen, web sign-in fallback and skeleton pass; the system-sheet sign-in times out
  after the sheet returns (not diagnosed); most flows exceed their deadline because Maestro is slow on
  the macOS runners. See COMPARISON.md.

## Known gaps

- **The tab bar is drawn by React Native**, not `UITabBar` / `BottomNavigationView`: the system tab
  bars host a screen per tab, and the one web view would have to be re-parented between them. It looks
  native but has no iOS 26 glass. See COMPARISON.md.
- **Keyboard drag-to-dismiss** is the app's own 40 px gesture in the page on both platforms; iOS's
  interactive dismissal (the keyboard following the finger) is not there (react-native-webview has no
  `keyboardDismissMode`).
- **Downloads on iOS** hand the address to the share sheet (no cookies); on Android react-native-webview
  gives it to DownloadManager with the page's cookies. The web app hides its one download in the shell.
- **Android navigations without JavaScript's answer in 250 ms** load if http(s) (react-native-webview's
  synchronous wait); other schemes are refused (patched).
- **The hosted sign-in's renewal** is unit-tested only (the mock has no hosted sign-in), as in the
  native shells.
- **A session cookie set seconds before the app is killed can be lost on iOS** (WebKit writes cookies
  lazily). The session is not copied anywhere else (no Keychain, no NSHTTPCookieStorage).

## Release tasks

- App icon and splash artwork (the 192 px mark stands in), signing (Apple team, Android upload key and
  Play App Signing), version numbers.
- Associated domains: `applinks:` / `webcredentials:my.open.bot` are in the entitlements; the
  association file must name `<TeamID>.ai.openbot.rnshell`. App Links: `assetlinks.json` must name
  `ai.openbot.rnshell` and the release key's SHA-256. Until then the app uses the custom scheme (Android
  only when the domain is not verified) or the web sign-in.
- The bundle id here is `ai.openbot.rnshell` (so it installs beside the native shells); pick the real one.
- R8/ProGuard is off (Expo's default); turning it on needs keep rules for the native modules.
