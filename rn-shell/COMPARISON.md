# Two native shells or one React Native shell

For the decision between keeping `ios-shell/` (Swift) and `android-shell/` (Kotlin), or replacing both
with `rn-shell/` (React Native with Expo). All three wrap the same web app in one web view and speak
the same server contracts; the numbers and findings below come from building the third one after the
first two, and running all three in CI.

## Where each one stands tonight (be blunt)

| | Native iOS | Native Android | RN iOS | RN Android |
| --- | --- | --- | --- | --- |
| Test suite | Green (4 parallel simulator jobs, PR 2383) | Green (2 emulator shards, PR 2380) | **Not green.** First screen, web sign-in fallback and the skeleton passed in CI; the system-sheet sign-in reaches the consent alert, the sheet and the skeleton (recorded) but then times out ("Sign-in took too long", cause not found yet); most flows ran out of time because Maestro on the macOS runners takes 60 to 70 s to start and 20 to 45 s per step | **18 of 19 mock flows and 2 of 3 real-backend flows pass** (run 46149889717, 7 minutes wall); the one mock failure was Maestro not reading the page's text after the web process restart (the app had recovered, screenshot), since changed to check native state; the real web sign-in is skipped when Cloudflare challenges the emulator |
| Demo recording | Yes | Yes | Partial (88 s: launch, consent, sheet, skeleton, then the sign-in timeout) | 175 s: first screen, sign-in, skeleton, Home, typing on the software keyboard with Send visible, a conversation with the keyboard (cut at screenrecord's limit) |
| Real backend | Session-cookie journey and web fallback green | Same, with Cloudflare skips | Not reached in CI tonight | Session-cookie journey (Home, Chats, Bots) and lock-when-unreachable pass; web sign-in to the identity provider passed once and is otherwise skipped by Cloudflare |

The RN shell's logic is well tested (59 unit tests of the pure reducer and helpers, run on every
push), but its UI suite on iOS is immature, and on Android it is green only after many rounds of
making the flows independent of each other and of Chromium's accessibility tree.

## Size of each approach (counted on 28 Nov 2026, non-blank lines)

| | iOS shell | Android shell | Both native | RN shell (one codebase) |
| --- | --- | --- | --- | --- |
| App code | 3,381 lines, 19 files (Swift, project.yml), 167 KB | 3,773 lines, 48 files (Kotlin, XML, Gradle), 180 KB | 7,154 lines, 67 files, 347 KB | 4,303 lines, 29 files, 158 KB: 3,657 TypeScript (formatted by Biome at 80 columns, which inflates the line count; 128 KB) and 646 platform lines (Swift module 132, Kotlin module 129 and trampoline 45, its manifest 32, config plugin 84, patch to react-native-webview 163) |
| Test code | 2,037 (XCUITest) | 2,578 (UiAutomator, JUnit) | 4,615 | 2,415: 1,707 unit tests (59 cases) and 708 lines of Maestro flows (26 files) |
| CI scripts and workflows | 1,213 | 1,229 | 2,442 | 1,482 (both platforms) |

By bytes the RN app is 46% of the two native apps together. The native shells carry about 540 lines
of diagnostics the RN shell does not; without them the comparison is roughly 6,600 native lines
against 4,300 RN lines, about 650 of which are still Swift, Kotlin, XML or a patch.

## What React Native made easier

- **One behaviour, written once and tested without a phone.** The app's whole state machine (sign-in,
  entering, renewal, sign-out, lock, skeleton, keyboard effects, process death, the navigation policy)
  is one pure TypeScript reducer: 59 unit tests run in under a second on any laptop and caught real mistakes
  before CI did (an error page lifting the lock; enter being reloaded after a restart). The native
  shells each implement the same rules twice, in two languages, tested mostly through slow UI tests.
- **Sign-in sheet**: `expo-web-browser` gives `ASWebAuthenticationSession` (non-ephemeral, shares
  Safari's sessions, iOS 17.4 https callbacks) and a Chrome Custom Tab with one call each.
- **The enter header**: `source={{ uri, headers }}` sends `OpenBot-Shell` on that one request on both
  platforms and on nothing after it (the header probe flow proves it on both).
- **The skeleton, first screen, lock screen and tab bar** are ordinary components, one copy for both
  platforms, from the same color scheme.
- **Keyboard**: React Native's keyboard events give the keyboard's top edge on both platforms (Android
  edge to edge included), so "the web view ends at the keyboard" is ten lines, the same on both.
- **iOS accessory bar**: `hideKeyboardAccessoryView` (the same private-class swizzle the native shell
  wrote by hand, so the same App Review exposure).
- **Content process death**: `onContentProcessDidTerminate` and `onRenderProcessGone` exist; the
  recovery is one remount at the last own-origin page.

## What it made harder, or needed native code anyway

Every place the RN shell drops to native code or configuration:

| Need | Why React Native could not do it | What the RN shell does |
| --- | --- | --- |
| Is there a session cookie (names only); set one for a test; clear a site's cookies, storage and cache on sign-out | No JavaScript API reaches WKHTTPCookieStore or Android's CookieManager; `@react-native-cookies/cookies` is unmaintained for the new architecture | `modules/shell-native` (Swift + Kotlin) |
| Android: another app's `openbotshell://` must not close the Custom Tab or end the pending sign-in | Expo's MainActivity is `singleTask`: any intent to it comes forward | A translucent trampoline activity in the module, forwarding only a well-formed ticket while a sign-in is pending |
| JavaScript dialogs: other origins' suppressed, the app's titled "OpenBot" | react-native-webview shows every frame's dialogs, untitled (iOS) or with Android's default title | A `patch-package` patch (both platforms) plus an injected script for other origins in the main frame |
| Android navigation policy needs "main frame?" and "tapped?" | react-native-webview's Android event has neither; it also waits only 250 ms for JavaScript's answer and then **allows** the load | The same patch adds both and fails closed for non-http(s) schemes; http(s) still loads after 250 ms (see risks) |
| The bridge must trust only the main frame of the app's own origin | react-native-webview's message channel answers every frame (iOS's handler is in all frames; Android registers its listener for origin `*` and drops `isMainFrame`) | A random per-launch token known only to the script in the main frame of the own origin, plus an origin check |
| A tight `originWhitelist` | It is a trap: whatever does not match is handed to `Linking.openURL` automatically (an `intent://` or `openbotshell://` link would leave the app) | `originWhitelist={["*"]}` and every decision in `onShouldStartLoadWithRequest` |
| Dismiss the web view's keyboard, flush cookies, read launch arguments, App Link verification state | Not in React Native | The module |
| No URL scheme, portrait only, ATS / cleartext per build | Expo adds the bundle id as a URL scheme and a local-networking ATS exception by default | A config plugin |
| Drag down to dismiss the keyboard | react-native-webview has no `keyboardDismissMode` | A 40 px gesture in the injected page script, on both platforms (no interactive dismissal) |
| Downloads on iOS | `onFileDownload` gives an address only (no cookies, no file) | The share sheet with the address; the native shell downloads the file with the session |
| A system tab bar | Expo Router's native tabs host a screen per tab; the one web view would have to be re-parented | Tabs drawn by React Native: no iOS 26 glass, not `BottomNavigationView` |

### The senior review's rules: where each one lives in React Native

| Rule | In JavaScript (react-native-webview's API) | Needed native code or a patch | Not possible with react-native-webview as it is |
| --- | --- | --- | --- |
| Clear the web view's session and site data before `enter`, and load `enter` only when that has finished | The waiting (the reducer holds `enter` until `siteDataCleared`) | Clearing: WKWebsiteDataStore / CookieManager and WebStorage in the module; react-native-webview's `clearCache` is per view, Android-only for history, and gives no completion | |
| Is there a session cookie (names only) | | The module (WKHTTPCookieStore, CookieManager) | |
| An `enter` that ends on `/sign?native-sign-in=failed` is a failure | Yes (the URL is in `onNavigationStateChange`) | | |
| During a renewal, ignore the outgoing page's `signed-out` and `/sign` | Yes (reducer) | | |
| Keep the verifier after a fake ticket | Yes (reducer) | Android: the trampoline keeps another app's callback from bringing the app forward | |
| Downloads only from the own origin | iOS: `onFileDownload` gives the address, so the app decides (share sheet, no cookies) | | Android: react-native-webview hands every download to DownloadManager itself, from any origin (a patch would be needed) |
| Microphone and camera only for the own origin (scheme, host and port) | Refused for every origin (`mediaCapturePermissionGrantType="deny"`, no Android permission declared) | | Per-origin grant: iOS offers only "same host" (not scheme or port), Android grants by the app's permissions, not the page's origin |
| `mailto:`, `tel:`, `sms:` from a new window | Yes: `onOpenWindow` gives the address, opened after a recent tap | | Telling a tap from a script: Android's window event carries no gesture flag (the app tracks taps in the page instead) |
| Bridge from the main frame of the own origin only | The token and origin check | | A frame check: the message event has no frame on Android and the channel is open to all frames |
| Dialogs: other origins suppressed, own titled OpenBot | Other origins' main-frame dialogs (an injected script) | The patch (frames, title) | |
| A dead content process recovers | Yes (`onContentProcessDidTerminate`, `onRenderProcessGone`, a remount) | | |

### Back: iOS's edge swipe and Android's Back button with a single-page app

- **What react-native-webview gives.** iOS: `allowsBackForwardNavigationGestures` turns on WKWebView's
  own swipe, which walks the web view's back-forward list, pushState entries included. Android: no
  Back handling at all; the app reads `canGoBack` from `onNavigationStateChange` and calls
  `goBack()` from React Native's `BackHandler`. Neither can see the list's entries, so neither can
  refuse "back to /sign or another site" directly: the RN shell keeps that list clean instead (a
  new web view after every sign-in) and refuses `backforward` navigations to /sign, /api/ or another
  site in its navigation policy (iOS reports the navigation type; Android does not).
- **The per-tab contract** (the page owns 3 stacks and reports `canGoBack`; Back is `openbot:back`):
  Android is JavaScript only (`BackHandler` asks the reducer: keyboard, page back, or leave the app).
  iOS needed no native code either, but only because a React Native `PanResponder` on a 20-point
  strip at the left edge stands in for the system gesture: it does not follow the finger with an
  interactive transition the way WKWebView's own swipe or a UINavigationController's does, and the
  strip takes touches at the very edge of the page. A gesture with the system's feel would need a
  native `UIScreenEdgePanGestureRecognizer` on the web view (a module or a patch). The native iOS
  shell can attach that recognizer directly.

Further friction found while building it:

- **A store build shipped the test hooks until Metro's cache was cleared.** `EXPO_PUBLIC_` values are
  inlined when a module is transformed, and Metro keeps transformed modules between runs; with
  `CI=true`, `--reset-cache` did not prevent it. CI now builds each flavour from no cache and greps
  the store bundles. The native shells' compile-time flags (`#if DEBUG`, Gradle source sets) cannot
  leak this way.
- **No true document-start script on Android**: react-native-webview runs "before content loaded"
  from `onPageStarted`, which is not guaranteed to beat the page (the native shell uses
  `addDocumentStartJavaScript`). The user agent marker covers detection, and the script runs again at
  document end.
- **Every web view event crosses to JavaScript**, so the native shells' synchronous decisions become
  asynchronous messages (the RN shell's state machine absorbs it, but it is more moving parts).
- **Build time and size** (below).

## Build, CI time and app size

| | Native iOS | Native Android | RN iOS | RN Android |
| --- | --- | --- | --- | --- |
| Clean build in CI | about 2 to 3 min | about 3 min | 12.5 to 15 min Release (prebuild, CocoaPods with React Native's prebuilt core, Hermes, Swift for the Expo modules); ccache barely helps because Xcode rebuilds after checkout | 6 to 8 min Release, x86_64 only |
| Test workflow, wall clock | about 18 min (4 parallel jobs) | about 12 min (2 shards) | build job, then 2 simulator shards: 15 min build on a source change plus a test job that did not finish inside 35 minutes tonight | 2 shards: 7 min when the APK is cached on its sources, about 15 min when it is rebuilt |
| App size | not measured (small) | 1.3 MB release APK (R8) | 52 MB Release simulator .app (arm64, unsigned) | 25.5 MB store APK, arm64-v8a only, R8 off |

React Native, Hermes and the Expo modules make the RN app about 20 times the native Android APK. An
App Bundle and R8 would roughly halve it; it stays an order of magnitude larger.

## App Store and Play review: what differs

- **Over-the-air updates.** Not installed here (`expo-updates` is absent). If the team adds EAS Update,
  JavaScript can change after review: allowed by both stores for bug fixes, but App Review guideline
  3.3.2 and Play's policy forbid changing the app's purpose or adding features that bypass review, and
  for a shell whose security rules live in JavaScript (the navigation policy, the bridge checks), an
  OTA channel is also a path to ship a weaker policy without native review. A native shell has no such
  channel.
- **Minimum functionality (4.2).** Identical exposure in all three: a web view app is judged on its
  native value (sign-in sheet, tab bar, lock screen, later notifications).
- **Private API.** `hideKeyboardAccessoryView` swizzles WebKit's private content view class exactly
  as the native shell does; same risk, but in a third-party library the team does not control.
- **Third-party SDK disclosure.** React Native, Expo and Hermes are accepted everywhere; Expo's
  privacy manifests are aggregated into the app (`apple.privacyManifestAggregationEnabled`).
- **Patched dependency.** A store build includes a patched react-native-webview: every upgrade has to
  re-apply and re-review the patch.

## Recommendation

Keep the two native shells for the product, and keep `rn-shell/`'s pure logic idea, not React Native
itself.

1. **Security sits in the web view's plumbing, and React Native puts a library between the app and
   it.** Four of the twelve security rules from the review needed native code or a patch to
   react-native-webview (dialogs, frame and gesture on Android, the open message channel, the
   whitelist trap), and one cannot be fully fixed without forking it (Android allows an http(s) load
   when JavaScript does not answer in 250 ms). The native shells hold these with the platform's own
   APIs.
2. **Maturity.** The native shells are green on both platforms with recordings; the RN shell is nearly
   green on Android only (18 of 19 mock flows), and its iOS sign-in through the sheet is not proven (it times out after the
   sheet returns). Closing that gap is more nights of work, on the slowest CI of the three.
3. **Size and build time.** 25 MB against 1.3 MB on Android; 12.5 to 15-minute iOS builds against 2 to
   3, so every change to the app's code costs a much longer CI round trip.
4. **The code saving is smaller than it looks.** About 4,300 lines (650 of them still Swift, Kotlin,
   XML and a patch) against about 6,600 native lines without diagnostics: React Native removes the
   duplicated UI (first screen, lock screen, skeleton, tab bar), but the shell is mostly web view
   policy, and much of that needed per-platform code anyway. The second security pass confirmed it:
   clearing site data and waiting for it, and reading the session cookie, are native module code;
   per-origin permissions and Android downloads cannot be enforced through react-native-webview
   without patching it further.
5. **It is a separate stack from `mobile/` in practice.** Same versions, but the shell adds a local
   native module, a config plugin and a patched web view that `mobile/` does not need.

Where React Native would win: if the phone app is going to grow native screens beyond the shell
(`mobile/`'s direction: Bot screens, conversations, routines in React Native), one RN app holding both
the native screens and this web view would beat three codebases. In that case move `rn-shell`'s
reducer, its tests and the module into `mobile/` rather than shipping the shell on its own.

What to take from this experiment either way: the pure, unit-tested state machine. Porting
`src/logic/machine.ts`'s rules into a shared specification (or its tests into both native suites)
would make the two native shells provably agree.
