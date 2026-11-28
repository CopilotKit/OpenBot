# Two native shells or one React Native shell

For the decision between keeping `ios-shell/` (Swift) and `android-shell/` (Kotlin), or replacing both
with `rn-shell/` (React Native with Expo). All three wrap the same web app in one web view and speak
the same server contracts; the numbers and findings below come from building the third one after the
first two, and running all three in CI.

## Size of each approach (non-blank lines, counted on 28 Nov 2026)

| | iOS shell | Android shell | Both native | RN shell |
| --- | --- | --- | --- | --- |
| App code | 3,200 lines, 19 files (Swift, project.yml) | 3,508 lines, 45 files (Kotlin, XML, Gradle) | 6,708 lines, 64 files | 4,077 lines, 29 files: 3,431 TypeScript, 646 native (a 160-line Swift module, a 210-line Kotlin module and trampoline, a 70-line config plugin, a 170-line patch to react-native-webview) |
| Tests | 1,952 (XCUITest) | 2,274 (UiAutomator, JUnit) | 4,226 | 1,992: 3 unit test files (48 cases, every rule of the app as a pure reducer) and 24 Maestro flows |
| CI scripts and workflows | 1,187 | 1,225 | 2,412 | 1,313 (both platforms) |

The native shells include about 540 lines of diagnostics (a page probe and JSON logging) the RN shell
does not have; without them the app code is roughly 6,200 native lines against 4,100 RN lines, of
which about 650 are still platform code. In both cases the web view does the real work.

## What React Native made easier

- **One behaviour, written once and tested without a phone.** The app's whole state machine (sign-in,
  entering, renewal, sign-out, lock, skeleton, keyboard effects, process death, the navigation policy)
  is one pure TypeScript reducer: 48 unit tests run in 20 ms on any laptop and caught real mistakes
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
| Clean build in CI | about 2 to 3 min (Swift only) | about 3 min (Gradle) | 13 to 14 min Release (prebuild, CocoaPods, React Native's prebuilt core, Hermes); ccache and a pods cache are wired in to cut repeats | about 8 min Release, x86_64 only |
| Whole test workflow (last runs) | about 22 min | about 10 min | see the final report: build plus 18 flows | see the final report |
| App size | not measured (a small SwiftUI app) | 1.3 MB (R8) | 52 MB simulator Release .app (arm64, unsigned) | 25.5 MB store APK, arm64-v8a only, R8 off |

The RN app carries React Native, Hermes and the Expo modules: about 20 times the native Android APK.
An Android App Bundle and R8 would roughly halve it; it stays an order of magnitude larger.

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
2. **Size and build time.** 25 MB against 1.3 MB on Android; 13-minute iOS builds against 2 to 3, which
   is the difference between a 20-minute and a 35-minute CI round trip for every change.
3. **The code saving is smaller than it looks.** About 4,100 lines (650 of them still Swift, Kotlin and
   patch) against 6,200 native lines without diagnostics: React Native removes the duplicated UI (first
   screen, lock screen, skeleton, tab bar), but the shell is mostly web view policy, and that needed
   per-platform code anyway.
4. **It is a separate stack from `mobile/` in practice.** Same versions, but the shell adds a local
   native module, a config plugin and a patched web view that `mobile/` does not need.

Where React Native would win: if the phone app is going to grow native screens beyond the shell
(`mobile/`'s direction: Bot screens, conversations, routines in React Native), one RN app holding both
the native screens and this web view would beat three codebases. In that case move `rn-shell`'s
reducer, its tests and the module into `mobile/` rather than shipping the shell on its own.

What to take from this experiment either way: the pure, unit-tested state machine. Porting
`src/logic/machine.ts`'s rules into a shared specification (or its tests into both native suites)
would make the two native shells provably agree.
