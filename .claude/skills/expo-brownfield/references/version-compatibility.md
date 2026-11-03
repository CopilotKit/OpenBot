# Select versions before integrating

Keep the workflow version-aware rather than pinning every host to one SDK. Existing projects retain their SDK unless an upgrade is part of the task. New producers should use the current stable Expo release when the host and toolchain can support it.

## Inspect and select

1. Read the producer's `package.json` and lockfile; record resolved `expo`, `react-native`, and `expo-brownfield` versions. Check the host's deployment targets, Xcode/Node versions, and native dependency graph, including any existing RN runtime.
2. For new work, check the [Expo releases](https://expo.dev/changelog/) and [SDK compatibility table](https://docs.expo.dev/versions/latest/#each-expo-sdk-version-depends-on-a-react-native-version). `npm view expo dist-tags --json` can confirm the current stable `latest` version. Do not infer stability from the highest SDK number or select `canary`/`next` by default.
3. Select an SDK compatible with the host's supported OS versions, modules, and build tools. Do not silently raise the host's minimum OS or swap its toolchain to satisfy a tutorial. If a constraint conflicts, explain the concrete choices before changing that product requirement.
4. Use that SDK's versioned Brownfield API docs and `sdk-<major>` native template. Install modules with `npx expo install`; run `npx expo install --check` before native builds. For an SDK upgrade, use `expo-upgrade`, preserve the host, and apply native diffs selectively.
5. Inspect the **installed** CLI's `build:ios --help` / `build:android --help`, plugin schema, generated Swift/Kotlin wrappers, and `Package.swift`. Flags, prebuilt defaults, import names, and binary products can change within a major release.

To scaffold a small new feature after those checks:

```sh
npx create-expo-app@latest my-project --template blank@latest
cd my-project
npx expo install expo-brownfield typescript @types/react
```

This avoids adding a Router shell just to export one component. For an existing Router app, preserve it and add the root-props adapter described in [feature integration](./feature-integration.md). If selecting an older SDK, use a verified template tag such as `blank@sdk-55`; the scaffolder's own `@latest` version does not determine the template's SDK. Commit the producer's lockfile for repeatable builds.

## SDK requirements and build defaults

| Surface | SDK 55 | SDK 57 |
| --- | --- | --- |
| React Native family | 0.83 | 0.86 |
| iOS minimum in the Expo template | 15.1 | 16.4 |
| Documented minimum Node / Xcode | 20.19.x / 26.2 | 22.13.x / 26.4 |
| Brownfield React Native build default | Source | Prebuilt |
| Precompiled Expo modules | Version/configuration dependent | Enabled by default in the native template |
| Swift Package products | 55.0.28: separate feature and Hermes products | 57.0.18: one aggregate product when precompiled modules are detected; otherwise separate products |

React Native prebuilt binaries and precompiled Expo modules are separate settings. Set React Native source mode on `expo-brownfield`'s `ios.buildReactNativeFromSource`. Expo module precompilation is controlled by `expo-build-properties`' `ios.usePrecompiledModules`. Do not disable defaults as a generic build fix; first inspect the failing dependency and toolchain requirement.

In 57.0.18, precompiled builds suffix the generated package/product with its configuration (`MyAppPackage-release` or `MyAppPackage-debug`). They do not rename the generated Swift module: continue to import the configured target, such as `MyBrownfield`. Inspect the emitted manifest instead of constructing an assumed package path.

SDK 56 introduced additional brownfield capabilities carried into SDK 57, including experimental multiple isolated frameworks and registering host Turbo Module classes. Load the selected SDK's API and installed interfaces only when the task needs them. Do not enable experimental multi-framework support for a single feature or assume two independently packaged RN runtimes can be linked together without collision handling.

Sources: [SDK requirements](https://docs.expo.dev/versions/latest/), [SDK 57 Brownfield API](https://docs.expo.dev/versions/v57.0.0/sdk/brownfield/), [SDK 57 native template](https://github.com/expo/expo/tree/sdk-57/templates/expo-template-bare-minimum), [SDK 56 brownfield additions](https://expo.dev/changelog/sdk-56), [published Brownfield package](https://www.npmjs.com/package/expo-brownfield).
