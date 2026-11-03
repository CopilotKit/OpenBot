# Brownfield: Integrated Approach

Add React Native and Expo directly to the existing native project's build system — Gradle on Android, CocoaPods on iOS — the same way you would add any other library. The native project gains React Native capabilities while keeping a single, unified build.

## When to use

- A single team owns both the native and React Native code.
- The team is comfortable adding React Native and Expo to the native build (Gradle plugin, CocoaPods pods).
- You want JS bundling and native compilation in the host's existing build pipeline. Both approaches support Metro during development.
- You prefer one repository and one build pipeline over shipping a prebuilt artifact.

If the native team must not need Node, Yarn, or React Native tooling, use [./brownfield-isolated.md](./brownfield-isolated.md) instead.

## Prerequisites

- **An Expo/React Native version pair compatible with the host** — check [version compatibility](./version-compatibility.md) before editing the host. Use the selected SDK's native template and installed APIs; do not infer the minimum version of integrated brownfield from the separate `expo-brownfield` package.
- **Node.js (LTS)** — runs JavaScript and the Expo CLI.
- The existing package manager and lockfile (commands below use Yarn as an example).
- **Xcode and CocoaPods** (iOS) — use the host's Gemfile/Bundler setup when available.

---

## 1) Create an Expo project

Create the Expo project inside or alongside the existing native project, using the SDK selected during host inspection. For a new small feature on the current stable SDK:

```sh
npx create-expo-app@latest my-project --template blank@latest
```

For TypeScript, install `typescript` and `@types/react` with `npx expo install`, then use the explicit entry point in [feature integration](./feature-integration.md#register-the-component-that-receives-input). The JS entry point registers a root component under the name `"main"` — this name must match the `moduleName` referenced from the native side later.

## 2) Establish the project layout

Keep the existing repository layout when possible and configure paths explicitly. If consolidating into an Expo root, the resulting native build roots should be `my-project/ios/<Host>.xcodeproj` and `my-project/android/settings.gradle`, not an extra nested `android/android-project/` directory. Preserve source files, targets, signing, schemes, and relative resource paths; verify the native host still builds after relocation.

Ensure hand-maintained `ios/` and `android/` files are tracked and included in any EAS upload. A create-expo-app `.gitignore` may exclude them by default. **Do not run prebuild on this host.** Apply native configuration and SDK upgrade diffs directly.

### Monorepo alternative

If the native projects cannot be moved, set up a monorepo with the Expo project as a workspace. Create a root `package.json`:

```json
{
  "version": "1.0.0",
  "private": true,
  "workspaces": ["my-project"]
}
```

Run `yarn install` at the root. This installs `node_modules` at the workspace root so Gradle and CocoaPods scripts can resolve React Native and Expo dependencies.

> **Monorepo callout:** with a monorepo, the Expo project is not at `../../` from the native projects. You must set `projectRoot` explicitly in Gradle and pass the project root to CocoaPods so autolinking can find the Expo project.

---

## 3) Configure Android

### `settings.gradle`

Register the React Native Gradle plugin and Expo autolinking. Reference: [bare-minimum template `settings.gradle`](https://github.com/expo/expo/blob/sdk-57/templates/expo-template-bare-minimum/android/settings.gradle).

```groovy
pluginManagement {
  def reactNativeGradlePlugin = new File(
    providers.exec {
      workingDir(rootDir)
      commandLine("node", "--print", "require.resolve('@react-native/gradle-plugin/package.json', { paths: [require.resolve('react-native/package.json')] })")
    }.standardOutput.asText.get().trim()
  ).getParentFile().absolutePath
  includeBuild(reactNativeGradlePlugin)

  def expoPluginsPath = new File(
    providers.exec {
      workingDir(rootDir)
      commandLine("node", "--print", "require.resolve('expo-modules-autolinking/package.json', { paths: [require.resolve('expo/package.json')] })")
    }.standardOutput.asText.get().trim(),
    "../android/expo-gradle-plugin"
  ).absolutePath
  includeBuild(expoPluginsPath)
}

plugins {
  id("com.facebook.react.settings")
  id("expo-autolinking-settings")
}

extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->
  ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)
}
expoAutolinking.useExpoModules()
expoAutolinking.useExpoVersionCatalog()
includeBuild(expoAutolinking.reactNativeGradlePlugin)
```

> **Monorepo:** add an explicit project root before `expoAutolinking.useExpoModules()` so autolinking finds your Expo project's `node_modules`.

### Top-level `build.gradle`

Add the React Native Gradle plugin classpath and the Expo root-project plugin:

```groovy
buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath('com.android.tools.build:gradle')
    classpath('com.facebook.react:react-native-gradle-plugin')
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}

allprojects {
  repositories {
    google()
    mavenCentral()
    maven { url 'https://www.jitpack.io' }
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
```

### `app/build.gradle`

Apply the React Native plugin and configure the `react { ... }` block. The full template is at [bare-minimum `app/build.gradle`](https://github.com/expo/expo/blob/sdk-57/templates/expo-template-bare-minimum/android/app/build.gradle); the minimum that must change in your existing module:

```groovy
apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()

react {
  entryFile = file(["node", "-e", "require('expo/scripts/resolveAppEntry')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim())
  reactNativeDir = new File(["node", "--print", "require.resolve('react-native/package.json')"].execute(null, rootDir).text.trim()).getParentFile().getAbsoluteFile()
  hermesCommand = new File(["node", "--print", "require.resolve('hermes-compiler/package.json', { paths: [require.resolve('react-native/package.json')] })"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/hermesc/%OS-BIN%/hermesc"
  codegenDir = new File(["node", "--print", "require.resolve('@react-native/codegen/package.json', { paths: [require.resolve('react-native/package.json')] })"].execute(null, rootDir).text.trim()).getParentFile().getAbsoluteFile()
  cliFile = new File(["node", "--print", "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })"].execute(null, rootDir).text.trim())
  bundleCommand = "export:embed"
  autolinkLibrariesWithApp()
}
```

The Hermes compiler resolution above follows SDK 57; use the selected SDK's template for other versions.

> **Monorepo:** set `root = file("../../")` (or wherever your Expo project lives) inside the `react { ... }` block.

### `gradle.properties`

```properties
reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64
newArchEnabled=true
hermesEnabled=true
```

`newArchEnabled` and `hermesEnabled` must match across all sub-modules in your build.

### `AndroidManifest.xml`

Add the `INTERNET` permission to your main manifest at `app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

In the debug-variant manifest at `app/src/debug/AndroidManifest.xml`, enable cleartext traffic so the app can talk to the local Metro bundler over HTTP:

```xml
<application
  android:usesCleartextTraffic="true"
  tools:targetApi="28"
  tools:ignore="GoogleAppIndexingWarning">
  ...
</application>
```

### `MainApplication.kt`

Initialize React Native and Expo lifecycle dispatch in your `Application` class:

```kotlin
package com.example.myapp

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages
    )
  }

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (_: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
```

### `ReactActivity`

Create an `Activity` that hosts a React Native screen. The `moduleName` returned by `getMainComponentName()` must match the name registered via `AppRegistry.registerComponent(...)` in your JS entry point (`"main"` for the default template).

```kotlin
package com.example.myapp

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MyReactActivity : ReactActivity() {

  override fun getMainComponentName(): String = "main"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
      this,
      BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {}
    )
  }
}
```

Register the activity in `AndroidManifest.xml` with a non-ActionBar theme:

```xml
<activity
  android:name=".MyReactActivity"
  android:theme="@style/Theme.AppCompat.Light.NoActionBar"
  android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"
/>
```

Launch it from existing native code:

```kotlin
startActivity(Intent(this, MyReactActivity::class.java))
```

---

## 4) Configure iOS

The integrated approach drives iOS through CocoaPods + Expo modules autolinking, exactly like a fresh Expo project. The key difference is that you are integrating into your existing Xcode project rather than starting from the template.

### `ios/Podfile`

Create (or update) `ios/Podfile` based on the [bare-minimum Podfile](https://github.com/expo/expo/blob/sdk-57/templates/expo-template-bare-minimum/ios/Podfile). The following excerpt follows SDK 57. For another SDK, adapt its matching template; preserve the host's other targets and Podfile hooks:

```ruby
require File.join(File.dirname(`node --print "require.resolve('expo/package.json')"`), "scripts/autolinking")
require File.join(File.dirname(`node --print "require.resolve('react-native/package.json')"`), "scripts/react_native_pods")

require 'json'
podfile_properties = JSON.parse(File.read(File.join(__dir__, 'Podfile.properties.json'))) rescue {}

ENV['EX_DEV_CLIENT_NETWORK_INSPECTOR'] ||= podfile_properties['EX_DEV_CLIENT_NETWORK_INSPECTOR']
ENV['RCT_USE_RN_DEP'] ||= podfile_properties['ios.buildReactNativeFromSource'] == 'true' ? '0' : '1'
ENV['RCT_USE_PREBUILT_RNCORE'] ||= podfile_properties['ios.buildReactNativeFromSource'] == 'true' ? '0' : '1'
ENV['RCT_HERMES_V1_ENABLED'] ||= '0' if podfile_properties['expo.useHermesV1'] == 'false'
ENV['EXPO_USE_PRECOMPILED_MODULES'] = '0' if podfile_properties['EXPO_USE_PRECOMPILED_MODULES'] == 'false'
ENV['EXPO_USE_PRECOMPILED_MODULES'] ||= '1'

platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'

prepare_react_native_project!

target 'MyApp' do
  use_expo_modules!

  config_command = [
    'node',
    '--no-warnings',
    '--eval',
    'require(\'expo/bin/autolinking\')',
    'expo-modules-autolinking',
    'react-native-config',
    '--json',
    '--platform',
    'ios'
  ]

  config = use_native_modules!(config_command)

  use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']

  use_react_native!(
    :path => config[:reactNativePath],
    :hermes_enabled => podfile_properties['expo.jsEngine'] == nil || podfile_properties['expo.jsEngine'] == 'hermes',
    :app_path => "#{Pod::Config.instance.installation_root}/..",
    :privacy_file_aggregation_enabled => podfile_properties['apple.privacyManifestAggregationEnabled'] != 'false',
  )

  post_install do |installer|
    react_native_post_install(installer, config[:reactNativePath], :mac_catalyst_enabled => false)
  end
end
```

The `16.4` fallback and prebuilt settings match the SDK 57 template; retain a higher host/module requirement and use the selected SDK's minimum for other versions. Replace `'MyApp'` with the existing Xcode target name. The `:app_path` value tells `use_react_native!` where the JS app lives — set it to the absolute path of your Expo project root if you are in a monorepo.

Create `ios/Podfile.properties.json` alongside the Podfile (defaults are fine):

```json
{
  "expo.jsEngine": "hermes",
  "EX_DEV_CLIENT_NETWORK_INSPECTOR": "true"
}
```

Install pods:

```sh
cd ios && pod install
```

Open the generated `.xcworkspace` (not the `.xcodeproj`) from now on.

### Xcode project changes

Merge these settings into the existing target. Compare against the native template for the selected SDK rather than copying the moving `main` template wholesale.

Configure script execution and Release bundling, then reconcile status-bar ownership with the native host.

#### 1. Disable user script sandboxing

In Xcode, select your project → app target → **Build Settings**, search for `ENABLE_USER_SCRIPT_SANDBOXING`, and set it to **No**. CocoaPods' Hermes scripts need to switch between debug and release engine binaries at build time, which sandboxing blocks.

#### 2. Add a Run Script phase to embed the JS bundle

On the app target's **Build Phases** tab, add a new **Run Script** phase **before** `[CP] Embed Pods Frameworks`. This phase bundles JS for release builds and is skipped automatically in debug (Metro serves the bundle then).

```sh
# Configure NODE_BINARY in ios/.xcode.env for the machine running Xcode.
# For example: export NODE_BINARY=$(command -v node)
if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then
  source "$PODS_ROOT/../.xcode.env"
fi
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

export PROJECT_ROOT="$PROJECT_DIR"/..

if [[ "$CONFIGURATION" = *Debug* ]]; then
  export SKIP_BUNDLING=1
fi
if [[ -z "$ENTRY_FILE" ]]; then
  export ENTRY_FILE="$("$NODE_BINARY" -e "require('expo/scripts/resolveAppEntry')" "$PROJECT_ROOT" ios absolute | tail -n 1)"
fi
if [[ -z "$CLI_PATH" ]]; then
  export CLI_PATH="$("$NODE_BINARY" --print "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })")"
fi
if [[ -z "$BUNDLE_COMMAND" ]]; then
  export BUNDLE_COMMAND="export:embed"
fi

if [[ -f "$PODS_ROOT/../.xcode.env.updates" ]]; then
  source "$PODS_ROOT/../.xcode.env.updates"
fi
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

`"$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'"`
```

> **Monorepo:** override `PROJECT_ROOT` to point at the Expo project (e.g. `export PROJECT_ROOT="$PROJECT_DIR"/../../my-project`). Without this, bundling looks for `node_modules` in the wrong directory.

This script writes `main.jsbundle` into the app's resources directory in release configurations. Without it, the `bundleURL()` fallback in `ReactNativeDelegate` resolves to `nil` and the React Native screen fails to load whenever Metro is not running.

#### 3. Update `Info.plist`

Expo templates set `UIViewControllerBasedStatusBarAppearance` to `NO` for React Native status-bar control. This is an app-wide setting: preserve the host's existing controller-based behavior when required, and adapt the embedded screen's status-bar handling. If the host adopts the template behavior, use:

```xml
<key>UIViewControllerBasedStatusBarAppearance</key>
<false/>
```

### Own the runtime without replacing the native window

Keep the existing `AppDelegate`, `SceneDelegate`, SwiftUI `App`, and navigation stack. Add one retained runtime owner and pass it to RN screens. This keeps the factory and its delegate alive across presentations without creating a competing `@main` or a new root window.

```swift
import UIKit
internal import Expo
import React
import ReactAppDependencyProvider

@MainActor
final class ReactNativeRuntime {
  private let delegate: ReactNativeDelegate
  let factory: ExpoReactNativeFactory
  let launchOptions: [UIApplication.LaunchOptionsKey: Any]?

  init(launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) {
    self.launchOptions = launchOptions
    let delegate = ReactNativeDelegate()
    delegate.dependencyProvider = RCTAppDependencyProvider()
    self.delegate = delegate
    self.factory = ExpoReactNativeFactory(delegate: delegate)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
```

Keep Swift import access levels consistent with the generated Expo module provider (SDK 55 and 57 providers use `internal import Expo`).

Create and retain `ReactNativeRuntime(launchOptions: launchOptions)` from the existing app delegate's launch callback. Forward Expo module lifecycle callbacks as described in [feature integration](./feature-integration.md#forward-lifecycle-events). If your delegate can inherit from `ExpoAppDelegate`, call `super` from its overrides; otherwise use the subscriber manager while preserving the existing superclass and host behavior.

The code above selects Metro in Debug and the embedded bundle in Release. It does not configure an Updates controller or a development-client launcher. Those integrations need their own SDK-matched delegate setup.

### Present a React Native screen

```swift
import UIKit

final class ReactNativeScreenViewController: UIViewController {
  private let runtime: ReactNativeRuntime
  private let initialProps: [AnyHashable: Any]?

  init(runtime: ReactNativeRuntime, initialProps: [AnyHashable: Any]? = nil) {
    self.runtime = runtime
    self.initialProps = initialProps
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("Use init(runtime:initialProps:)")
  }

  override func loadView() {
    view = runtime.factory.rootViewFactory.view(
      withModuleName: "main",
      initialProperties: initialProps,
      launchOptions: runtime.launchOptions
    )
  }
}
```

From the existing UIKit controller, using the runtime supplied by the app:

```swift
let screen = ReactNativeScreenViewController(
  runtime: runtime,
  initialProps: ["userId": "123"]
)
navigationController?.pushViewController(screen, animated: true)
```

For SwiftUI, retain the existing `@main struct HostApp: App`. If it has no delegate, attach one with `@UIApplicationDelegateAdaptor(AppDelegate.self)`; if it already has one, extend that delegate. Pass the retained runtime through the host's view hierarchy and wrap the controller:

```swift
import SwiftUI

struct EmbeddedReactScreen: UIViewControllerRepresentable {
  let runtime: ReactNativeRuntime
  let userId: String

  func makeUIViewController(context: Context) -> ReactNativeScreenViewController {
    ReactNativeScreenViewController(
      runtime: runtime,
      initialProps: ["userId": userId]
    )
  }

  func updateUIViewController(_ controller: ReactNativeScreenViewController, context: Context) {}
}
```

Present `EmbeddedReactScreen` from the host's sheet or navigation destination. Initial props are creation-time input; use messaging/shared state for subsequent changes. For input registration, result handling, and dismissal, read [feature integration](./feature-integration.md).

Only use `factory.startReactNative(withModuleName:in:launchOptions:)` with a window when the task explicitly calls for making RN the app's root. It is not necessary for this embedded-screen recipe.

> **Monorepo iOS:** `pod install` is run from `ios/`, but Node module resolution starts from the Expo project root. Pass `EXPO_PROJECT_ROOT=/absolute/path/to/expo-project` to the `pod install` invocation if autolinking cannot find the Expo project automatically.

---

## 5) Test the integration

Start Metro from the Expo project (or `yarn start` from the monorepo root):

```sh
yarn start
```

Build and run the native app normally (Android Studio / Xcode). Navigate to your React Native-powered Activity or screen - it loads JS from the Metro dev server with hot reloading.

### Development vs. production

- **Development** — Metro serves the JS bundle with hot reloading over HTTP. Debug builds use the Metro URL via `RCTBundleURLProvider` (iOS) or the dev server detection in `ReactActivity` (Android).
- **Production** — Metro is not used. The configured Gradle/Xcode build phases invoke `export:embed`. Stop Metro and run the host in Release; verify input, result, dismissal, and reopening as in [feature integration](./feature-integration.md#acceptance-scenario).

For Metro connection issues, build failures, missing modules, or arch mismatches, see [./troubleshooting.md](./troubleshooting.md).

---

## Related references

- [./brownfield-isolated.md](./brownfield-isolated.md) — Alternative: ship RN as a prebuilt AAR/XCFramework.
- [./comparison.md](./comparison.md) — Decide between isolated and integrated.
- [./troubleshooting.md](./troubleshooting.md) — Common Metro, build, and integration issues.
