# Brownfield Troubleshooting

Cross-cutting issues that apply to both the isolated and integrated approaches. For approach-specific setup, see [./brownfield-isolated.md](./brownfield-isolated.md) or [./brownfield-integrated.md](./brownfield-integrated.md).

## Build failures

**Symptom:** Gradle or Xcode build fails after a config change, dependency upgrade, or Expo SDK bump.

First inspect the failing build step and the dependency/configuration diff.

- **Integrated approach:** keep the hand-maintained host intact. Run `npx expo install --check` in the JS project, apply SDK-matched native template changes selectively, then run `bundle exec pod install` (or `pod install` without Bundler) in the host's Podfile directory. Open the `.xcworkspace`. Neither `prebuild` nor `prebuild --clean` is a recovery step for this host: [clean prebuild deletes native directories](https://docs.expo.dev/workflow/continuous-native-generation/#optionality).
- **Isolated approach:** rebuild the affected platform in the separate Expo producer, then replace the consumer's artifact and its accompanying dependencies. CNG regeneration belongs only in that producer, after checking that its native files are generated and reproducible.
- For stale iOS build products, clean the affected target's build folder/DerivedData. Preserve `Podfile.lock`; deleting it changes dependency resolution and can hide the cause. Reinstall pods only when the error points to the pod installation.
- For Android, clean the affected project's build outputs with its Gradle wrapper. Inspect publication coordinates and dependency resolution before removing a specific stale local Maven artifact; do not clear unrelated caches.

## Missing autolinked Expo modules

**Symptom:** Compilation succeeds but a module throws "Native module cannot be null" / "Cannot find native module 'X'" at runtime.

- Install with `npx expo install <package>` rather than plain `yarn add` — `expo install` picks the version compatible with the current SDK.
- After installing a new module, rebuild the native app. Autolinking runs at native build time, not at JS bundle time.
- For the **isolated approach**, you must re-run `npx expo-brownfield build:android|ios` after adding a module, and republish/re-embed the new artifact.

## Metro connection

**Symptom:** "Could not connect to development server" / red screen on launch in debug.

- Ensure the device or emulator can reach the dev machine. The Android emulator can talk to the host via `10.0.2.2`; physical devices need a reachable LAN IP.
- For physical Android devices on USB: `adb reverse tcp:8081 tcp:8081`.
- Confirm Metro is actually running: `npx expo start` from the Expo project (or `yarn start` from the workspace root).
- Verify the debug `AndroidManifest.xml` enables cleartext traffic — Android 9+ blocks HTTP by default. The debug variant should include `android:usesCleartextTraffic="true"` on `<application>`, or a `network_security_config` allowing the dev server.
- iOS simulator: Metro should be reachable at `localhost:8081`. If it is not, check that ATS exceptions are still in place in `Info.plist` for `localhost` (the Expo template ships this by default).

## iOS XCFramework signing (isolated approach)

**Symptom:** App launches but immediately crashes with "Library not loaded" or codesign errors during archive.

- Inspect the actual output and generated `Package.swift`; the framework set depends on package version and source/prebuilt settings, not only the SDK major. Link all required binaries and embed/sign dynamic frameworks. Do not apply **Embed & Sign** to static binaries. See the [artifact instructions](./brownfield-isolated.md#ios).
- The frameworks must be added to the _app target_, not a framework or extension target.
- With Swift Package output (`build:ios --package`), inspect the manifest and link all required products. Precompiled builds on SDK 57 expose an aggregate product; other configurations and older packages can expose separate products. See [version compatibility](./version-compatibility.md).

## iOS architecture / simulator mismatch

**Symptom:** "Building for iOS Simulator, but the linked library was built for iOS" or "Undefined symbols for architecture arm64".

- The XCFramework includes both device and simulator slices. If a slice is missing, rebuild on the missing platform. The `expo-brownfield build:ios` command produces both by default.
- On Apple Silicon simulators, do **not** set `EXCLUDED_ARCHS = arm64` for the simulator configuration — Apple Silicon simulators require `arm64`. The classic Rosetta-only exclusion is no longer correct.

## Android `mavenLocal()` not found (isolated approach)

**Symptom:** Gradle reports "Could not find com.example:mybrownfield:1.0.0" even after a successful `expo-brownfield build:android`.

- `mavenLocal()` must be declared under `dependencyResolutionManagement { repositories { ... } }` in `settings.gradle.kts`, not the deprecated top-level `allprojects { repositories { ... } }` block. The deprecated form is silently ignored when `dependencyResolutionManagement` is present.
- Confirm the artifact actually landed in `~/.m2`:
  ```sh
  find ~/.m2/repository -name "mybrownfield*"
  ```
- Verify the `group` and `libraryName` in the consumer's dependency line match what the plugin config emitted.

## Module name mismatch

**Symptom:** The native view loads but renders a blank screen, with "Application 'X' has not been registered" in the JS logs.

- The `moduleName` passed to `ReactNativeViewController(moduleName: "main")` (iOS) or returned from `getMainComponentName()` (Android) must equal the name passed to `AppRegistry.registerComponent("main", () => App)` in the JS entry point.
- The default Expo template registers `"main"`. If you changed the registration, update every native call site.

## Monorepo: autolinking can't find the Expo project

**Symptom:** Gradle or CocoaPods fails resolving Expo modules even though they are installed.

- **Android (integrated):** set `root = file("../../my-project")` (or the correct relative path) inside the `react { ... }` block in `app/build.gradle`, and explicitly set the project root in `settings.gradle` before `expoAutolinking.useExpoModules()`.
- **iOS (integrated):** set `:app_path` in `use_react_native!` to the absolute path of the Expo project root. Optionally pass `EXPO_PROJECT_ROOT=/abs/path` to `pod install`.
- Confirm `node_modules/` is installed at the workspace root (`yarn install` from the monorepo root, not from the Expo project subdirectory).

## After upgrading Expo SDK

First check the selected SDK's Node, Xcode, and minimum OS requirements in [version compatibility](./version-compatibility.md). An unsupported compiler or older deployment target is not repaired by clearing caches. If the brownfield setup stops building after an SDK upgrade:

- Re-run `npx expo install --fix` in the Expo project to align native module versions.
- Isolated: regenerate only the CNG-owned producer if needed, rebuild its artifact, and update the host dependency. Integrated: apply native upgrade diffs to the existing host and reinstall pods; preserve its source files and project configuration.
- Compare the new `templates/expo-template-bare-minimum` for the target SDK against your customized native files — Expo occasionally changes Gradle plugin names, Podfile helpers, or AppDelegate entry points across SDKs.

## Result missing, duplicate callbacks, or a sheet that will not close

- Check the module registration and per-presentation request ID. Root props need an explicit JS entry point; do not assume a Router route receives native `initialProps` directly.
- Attach the host listener before mounting RN and supply required startup data through initial props. For live updates, verify subscription readiness and use acknowledgements where delivery matters; messages are not a durable queue.
- Remove only this feature's listeners on completion, cancellation, and host dismissal. Dispatch UI changes to the main thread.
- `popToNative()` depends on the native wrapper: the SDK 55 UIKit controller pops navigation, and its SwiftUI wrapper separately calls `dismiss()`. Custom integrated containers need their own handler. Check which wrapper is actually mounted, or let the host close it on a result/close message. See [feature integration](./feature-integration.md).
