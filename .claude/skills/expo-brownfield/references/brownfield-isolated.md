# Brownfield: Isolated Approach

Build the React Native + Expo code as a prebuilt native library, **AAR** on Android and **XCFramework** on iOS, and consume it from the existing native app like any other dependency.

## When to use

- Native and React Native are owned by different teams or release on different cadences.
- The native team must not be required to install Node.js, Yarn, or React Native tooling.
- React Native code lives in a separate repo or monorepo from the native app.
- You want the smallest possible footprint on the existing native build pipeline.

If a single team owns both layers, is comfortable with React Native tooling and needs deep integration, see [./brownfield-integrated.md](./brownfield-integrated.md).

## What you produce

| Platform | Artifact                                                                                                                                                                                                                | Default location                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Android  | `{group}:{libraryName}:{version}` AAR                                                                                                                                                                                   | Local Maven (`~/.m2`) by default; remote Maven also supported |
| iOS      | Set of `.xcframework`s (depends on source/prebuilt settings and package version), or a Swift Package via `--package`; see [iOS](#ios) | `./artifacts`                                                 |

The JavaScript bundle is **embedded inside the artifact** in release builds, so the native app does not need Metro at runtime in production.

## Prerequisites

- **Expo SDK 55 or later for this Expo toolkit** — `expo-brownfield` was introduced in SDK 55. Match package versions and native requirements to the selected SDK; this is not a minimum for historical integrated setups.
- **Node.js (LTS)** — runs JavaScript and the Expo CLI.
- The existing package manager and lockfile. Yarn is not required.

Node and the JS package manager are only needed in the environment that _builds_ the artifact. The consuming native app does not need them.

---

## 1) Set up the Expo project

### Create a new Expo project

```sh
npx create-expo-app@latest my-project --template blank@latest
```

Use this current stable blank template for a small embedded feature after the [version/toolchain checks](./version-compatibility.md). If host constraints require another SDK, select its published template tag instead. Keep an existing producer and its entry point when present. The project can live in a separate repo or alongside the native app in a monorepo; it does not need to be inside the native project.

### Install expo-brownfield

```sh
cd my-project
npx expo install expo-brownfield
```

Check that the plugin registered in `app.json`; add it explicitly if the install command did not update the config (for example, with dynamic app configuration). Defaults derive from your app config.

### Check what the host app already ships

Before picking Expo modules, audit the host app's dependencies. The artifact's libraries meet the host's at build time, and version clashes surface as duplicate-class errors or forced upgrades.

- **Jetpack Compose** — `@expo/ui` re-declares recent Compose and Material3 versions, and is pulled transitively by `expo-router`. A host pinned to older Compose gets force-upgraded. Exclude it with `expo.autolinking.android.exclude` if the RN screens don't need it.
- **OkHttp, Kotlin stdlib, Material Components** — arrive as ordinary Maven dependencies of the artifact; Gradle resolves the highest version, which can bump the host's copies.

When a shared library must stay at the host's version, exclude the Expo module that brings it, or (with fused publishing, below) mark the group as host-provided.

### Configure the plugin (optional)

To override the auto-generated names, expand the plugin entry in `app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-brownfield",
        {
          "ios": {
            "targetName": "MyBrownfield",
            "bundleIdentifier": "com.example.mybrownfield"
          },
          "android": {
            "libraryName": "mybrownfield",
            "group": "com.example",
            "package": "com.example.mybrownfield",
            "version": "1.0.0"
          }
        }
      ]
    ]
  }
}
```

**iOS options** — `targetName` (XCFramework target name), `bundleIdentifier` (framework bundle ID).

**Android options** — `libraryName` (AAR name), `group` (Maven group ID), `package` (Android package), `version` (library version), `publishing` (Maven publication targets — see [Publishing the Android AAR](#publishing-the-android-aar)).

### Speed up iOS builds with prebuilt Expo modules

SDK 57 enables precompiled Expo modules by default. For a supported SDK where an explicit opt-in is needed, install `expo-build-properties` with `npx expo install expo-build-properties` and enable its `ios.usePrecompiledModules` so `pod install` downloads each Expo module as a prebuilt `.xcframework` instead of compiling it from source. `build:ios` detects those xcframeworks under `ios/Pods/` and bundles them into the Swift Package output alongside the brownfield framework, React, Hermes, and `ReactNativeDependencies`.

```json
{
  "expo": {
    "plugins": [
      ["expo-build-properties", { "ios": { "usePrecompiledModules": true } }],
      "expo-brownfield"
    ]
  }
}
```

When precompiled modules are detected, `build:ios` is pinned to a single flavor (`--debug` or `--release`) per package — Swift Package Manager has no per-configuration overload for `.binaryTarget(path:)`. Build once per flavor and distribute the two packages side by side.

---

## 2) Build the native libraries

### Android

```sh
npx expo-brownfield build:android
```

Produces an AAR and publishes it to the local Maven repository at `~/.m2`. The Maven coordinates come from the plugin config — e.g. `com.example:mybrownfield:1.0.0`.

#### Publishing the Android AAR

The plugin's `publishing` option controls where the AAR is published. When unset, it defaults to local Maven. To push to other targets (e.g. a shared CI Maven, an internal Artifactory/Nexus, or a folder pulled into another build), declare the publications explicitly:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-brownfield",
        {
          "android": {
            "libraryName": "mybrownfield",
            "group": "com.example",
            "version": "1.0.0",
            "publishing": [
              { "type": "localMaven" },
              {
                "type": "localDirectory",
                "name": "build",
                "path": "./out/maven"
              },
              {
                "type": "remotePublic",
                "name": "company",
                "url": "https://maven.example.com/releases"
              },
              {
                "type": "remotePrivate",
                "name": "artifactory",
                "url": { "variable": "ARTIFACTORY_URL" },
                "username": { "variable": "ARTIFACTORY_USER" },
                "password": { "variable": "ARTIFACTORY_TOKEN" }
              }
            ]
          }
        }
      ]
    ]
  }
}
```

Supported `type` values: `localMaven`, `localDirectory`, `remotePublic`, `remotePrivate`. For private repos, credentials and URL accept either inline strings or `{ "variable": "ENV_VAR_NAME" }` to read from the environment at publish time.

By default, `build:android` runs every declared publication. To pick specific publications or repositories from the command line, use the CLI flags:

```sh
npx expo-brownfield build:android --task publishReleasePublicationToCompanyRepository
npx expo-brownfield tasks:android   # list available publish tasks and repositories
```

#### Fused publishing (single fat AAR)

> **Version note:** requires minimum SDK 56. Earlier versions only support the per-module publishing above.

The default publish flow emits one Maven coordinate per autolinked Expo module. For remote distribution, `--fused` collapses everything into one fat AAR per build variant:

```sh
npx expo-brownfield build:android --fused --repo MavenLocal
```

This publishes two coordinates — `{group}:{libraryName}-fused-release` and `{group}:{libraryName}-fused-debug`, which the host wires per build type:

```kotlin
dependencies {
  releaseImplementation("com.example:mybrownfield-fused-release:1.0.0")
  debugImplementation("com.example:mybrownfield-fused-debug:1.0.0")
}
```

The debug AAR contains debug-compiled modules (dev menu, Metro reload); the release AAR embeds the JS bundle. Published metadata pins the matching React Native variant, so a debug host consuming only the release AAR still resolves release RN correctly.

Not everything is fused: the React Native runtime, Kotlin stdlib, host-common libraries (Material, Guava, OkHttp, Fresco), `androidx.*`, and detected KMP umbrella modules stay external and are declared as ordinary POM dependencies. Gradle properties tune the behavior for unusual dependency graphs:

| Property                              | Effect                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `brownfield.fused.skip`               | Gradle project names to leave out of the AAR (pair with `strip-packages`).                                                           |
| `brownfield.fused.strip-packages`     | Package prefixes to remove from `ExpoModulesPackageList` — avoids `NoClassDefFoundError` for skipped modules.                        |
| `brownfield.fused.androidx-fuse`      | Extra `androidx.*` groups to fuse instead of keeping external.                                                                       |
| `brownfield.fused.exclude-transitive` | Extra groups to keep external (still declared in the POM).                                                                           |
| `brownfield.fused.host-provided`      | Groups the host already ships (e.g. Glide, Compose): excluded from the AAR **and** from the POM, so the host's version is untouched. |

### iOS

```sh
npx expo-brownfield build:ios
```

Outputs to `./artifacts`. Set `ios.buildReactNativeFromSource` on the **`expo-brownfield` plugin**; it applies the build-properties configuration itself and can override a separate `expo-build-properties` entry. The set depends on that setting and the installed package version:

- **`buildReactNativeFromSource: false`** (default on SDK 56+) — React Native is consumed as a prebuilt binary. A typical set includes: `{TargetName}.xcframework`, `React.xcframework`, `ReactNativeDependencies.xcframework`, `ExpoModulesJSI.xcframework`, and `hermesvm.xcframework`.
- **`buildReactNativeFromSource: true`** (default on SDK 55, opt-in on SDK 56+) — React Native is compiled from source and statically linked into the brownfield framework, typically leaving: `{TargetName}.xcframework` and `hermesvm.xcframework`.

To force source builds, configure the brownfield plugin directly in `app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-brownfield",
        { "ios": { "buildReactNativeFromSource": true } }
      ]
    ]
  }
}
```

Use the actual output and generated package manifest as the dependency inventory; precompiled modules can add more binaries. Link all required frameworks and **Embed & Sign dynamic frameworks**. Static binaries are linked, not embedded. Do not mix source-linked React Native with another copy already in the host. The Swift Package output below describes the produced dependencies.

> **iOS deployment target:** compare the host's supported OS versions with the selected Expo/RN version and every produced binary. If the artifact requires a higher floor, resolve that product constraint before integration; changing a build setting cannot make a newer binary support older iOS releases.

#### Ship as a Swift Package (recommended)

Pass `--package [name]` to generate a local Swift Package around the XCFramework output. Add it with **Add Package Dependencies → Add Local**, then inspect `Package.swift` and select the products the host requires. Packaging layout and products vary by CLI version.

```sh
npx expo-brownfield build:ios --release --package MyAppPackage
```

Confirm `--package` in the installed CLI's help before using it. It accepts an optional package name. Inspect the printed output directory and its `Package.swift` instead of assuming the package name also changes the framework/module name (`MyBrownfield` in this guide).

Use separate output directories for Debug and Release. The CLI can clear its selected artifacts directory before writing a package, so changing only the package name is not a safe way to preserve the previous flavor:

```sh
npx expo-brownfield build:ios --debug --artifacts ./artifacts-debug --package MyAppPackage
npx expo-brownfield build:ios --release --artifacts ./artifacts-release --package MyAppPackage
```

Build Debug and Release artifacts separately when the producer requires a single flavor per package. A host built in Debug with a Release binary still contains Release RN code; it does not become a Metro-enabled artifact. Swift Package Manager does not select `.binaryTarget(path:)` by Xcode configuration. Select the matching package before each host build, or use explicit build-system wiring that supplies matching binaries; do not link both packages with duplicate module names into one target.

### Generate native projects for debugging

To inspect the generated native code, run prebuild **from the separate Expo producer whose native directories are CNG-owned**, never from the consuming host:

```sh
npx expo prebuild
```

This creates `android/` and `ios/` directories containing the brownfield wrappers:

**Android (Kotlin):** `ReactNativeHostManager`, `BrownfieldActivity`, `ReactNativeFragment`, `ReactNativeViewFactory`, `BrownfieldMessaging`.

**iOS (Swift):** `ReactNativeHostManager`, `ReactNativeViewController`, `ReactNativeView` (SwiftUI), `BrownfieldMessaging`, `ReactNativeDelegate`.

---

## 3) Consume from the native app

### Android

#### Add the Maven dependency

In `app/build.gradle.kts`:

```kotlin
dependencies {
  implementation("com.example:mybrownfield:1.0.0")
}
```

If consuming from the local Maven repo, register `mavenLocal()` in `settings.gradle.kts`:

```kotlin
dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
    mavenLocal()
  }
}
```

> **Note:** `mavenLocal()` must be added under `dependencyResolutionManagement`, not the deprecated top-level `allprojects { repositories { ... } }` block.

If the artifact is published to a remote Maven, declare that repository in the same `dependencyResolutionManagement` block instead — credentials follow Gradle's standard `maven { url = uri(...); credentials { username = ...; password = ... } }` form.

#### Host app requirements

- **`minSdk` 24 or higher** — React Native's floor. Hosts below it fail at manifest merge with `uses-sdk:minSdkVersion XX cannot be smaller than version 24`.
- **Permissions merge in from the Expo modules** (e.g. storage permissions from media modules). Hosts that enforce a permission allowlist can strip unwanted entries in their manifest with `tools:node="remove"` or reconcile attribute conflicts with `tools:replace`.
- **Native libraries ship for every ABI enabled at publish time.** Left unfiltered, this can multiply the host APK size. Constrain ABIs when publishing (`reactNativeArchitectures=arm64-v8a` in the Expo project's `gradle.properties`) or filter in the host with `ndk.abiFilters` / APK splits.

#### Show a React Native screen

Extend `BrownfieldActivity` and call `showReactNativeFragment()`:

```kotlin
import android.os.Bundle
import com.example.mybrownfield.BrownfieldActivity
import com.example.mybrownfield.showReactNativeFragment

class ExpoActivity : BrownfieldActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    showReactNativeFragment()
  }
}
```

`BrownfieldActivity` extends `AppCompatActivity` and forwards configuration changes. `showReactNativeFragment()` registers the React Native root fragment and wires native back-button handling automatically.

Register the activity in `AndroidManifest.xml`:

```xml
<activity
  android:name=".ExpoActivity"
  android:theme="@style/Theme.AppCompat.Light.NoActionBar"
  android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"
/>
```

Launch it from native code:

```kotlin
startActivity(Intent(this, ExpoActivity::class.java))
```

### iOS

#### Add the artifacts to the Xcode project

If you built a **Swift Package** (`build:ios --package …`):

- In Xcode, **File → Add Package Dependencies… → Add Local…**, then select the generated package directory (e.g. `artifacts/MyAppPackage/`).
- In `expo-brownfield@57.0.18`, precompiled-module builds generate a configuration-suffixed package/product such as `MyAppPackage-release`; select that aggregate product, which includes the binary targets. The Swift import remains the configured framework module (`MyBrownfield`), not the package name. Without precompiled modules, the CLI generates separate library products: add all required products from `Package.swift`. SDK 55.0.28 likewise exposes separate `MyBrownfield` and `hermesvm` products.
- If you produced Debug and Release packages, explicitly select the matching dependency before building the host; Xcode does not switch local binary packages automatically.

If you built **standalone XCFrameworks** (default output):

- Drag **every** `.xcframework` produced under `./artifacts` into the Xcode project navigator.
- In the import dialog, check **Copy items if needed** and add them to your app target.
- Under the app target's **General** tab → **Frameworks, Libraries, and Embedded Content**, embed and sign the dynamic frameworks; link static binaries without embedding them. For missing runtime dependencies, see [./troubleshooting.md](./troubleshooting.md#ios-xcframework-signing-isolated-approach).

#### Initialize React Native at app launch

Merge `ReactNativeHostManager.shared.initialize()` into the existing launch callback **before any React Native view is created**. Keep the native window and navigation. This delegate example uses the generated framework's `ExpoBrownfieldAppDelegate` to forward lifecycle callbacks; if a custom superclass prevents that, use the delegate-forwarding path in [feature integration](./feature-integration.md#forward-lifecycle-events).

```swift
import UIKit
import MyBrownfield // The configured framework target, not the Swift Package name

// Merge into the existing delegate. Keep its existing @main only for a UIKit entry point.
class AppDelegate: ExpoBrownfieldAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    ReactNativeHostManager.shared.initialize()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

#### Present a React Native view (UIKit)

```swift
import UIKit
import MyBrownfield

class ViewController: UIViewController {
  @IBAction func openReactNative(_ sender: Any) {
    let rnViewController = ReactNativeViewController(moduleName: "main")
    navigationController?.pushViewController(rnViewController, animated: true)
  }
}
```

Pass props and launch options if needed:

```swift
let rnViewController = ReactNativeViewController(
  moduleName: "main",
  initialProps: ["userId": "123"],
  launchOptions: [:]
)
```

> **Note:** `moduleName` must match the name registered via `AppRegistry.registerComponent(...)` in the Expo project's JS entry point. The default Expo template registers `"main"`.

#### Present a React Native view (SwiftUI)

Keep the existing `@main struct HostApp: App`. Add `@UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate` there only if the host has no delegate adaptor yet. Extend an existing delegate instead of introducing a second one. This connects initialization and lifecycle forwarding without changing the `WindowGroup`.

```swift
import SwiftUI
import MyBrownfield

struct ContentView: View {
  @State private var showReactNative = false

  var body: some View {
    Button("Open React Native") {
      showReactNative = true
    }
    .fullScreenCover(isPresented: $showReactNative) {
      ReactNativeView(moduleName: "main")
    }
  }
}
```

---

## Development vs. production

### Development (debug builds)

Start Metro in the Expo project:

```sh
npx expo start
```

Build a Debug artifact (`npx expo-brownfield build:ios --debug` on iOS), select it in the host, then build and run the native app in Debug. React Native screens load JS from the Metro dev server over HTTP with full hot reloading. The device or emulator must be able to reach the dev machine — see [./troubleshooting.md](./troubleshooting.md) if Metro connections fail.

### Production (release builds)

Build/select the Release artifact and build the host in Release. Stop Metro and verify JS and image assets load, then exercise input, result, dismissal, and reopening using the [acceptance scenario](./feature-integration.md#acceptance-scenario).

---

## Related references

- [./brownfield-integrated.md](./brownfield-integrated.md) — Alternative: add RN directly to the native build.
- [./comparison.md](./comparison.md) — Decide between isolated and integrated.
- [./troubleshooting.md](./troubleshooting.md) — Common Metro, build, and integration issues.
