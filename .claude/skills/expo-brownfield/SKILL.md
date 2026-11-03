---
name: expo-brownfield
description: Integrate Expo and React Native into an existing native iOS or Android app. Use for brownfield, embedding a React Native screen in SwiftUI/UIKit or Kotlin, or AAR/XCFramework packaging. Covers isolated and integrated approaches. For building or distributing a purely native app with EAS, use eas-app-stores.
---

# Expo Brownfield

A **brownfield** app is an existing native iOS or Android app that adopts React Native incrementally, as opposed to a **greenfield** app that is React Native from day one.

## Inspect the host first

Identify the existing app entry point, navigation owner, native build system, deployment targets, and any React Native runtime already linked. Record the installed Expo, React Native, and brownfield package versions from the lockfile. Adding EAS Build or Submit to a Swift app alone does not require React Native; route that task to `eas-app-stores`.

Preserve the host's SwiftUI `App` / UIKit window and native screens when embedding a feature. **Do not run prebuild in a manually maintained native host**, including during troubleshooting. An isolated Expo producer may use CNG; keep its generated `ios/` and `android/` separate from the consuming app.

Expo supports two distinct ways to add React Native to a brownfield project:

| Approach       | What ships to the native app                                        | When to choose                                                                   |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Isolated**   | Prebuilt AAR / XCFramework                                          | Native team doesn't need Node or RN tooling; RN code can live in a separate repo |
| **Integrated** | React Native sources added to the existing Gradle / CocoaPods build | One team owns everything; comfortable with RN tooling; wants a single build      |

For the full decision matrix, see [./references/comparison.md](./references/comparison.md).

## Pick an approach

Use these quick rules — fall through to `comparison.md` for anything ambiguous.

- **Choose isolated** if the iOS/Android team must consume RN as a regular library dependency (AAR or XCFramework), without installing Node, Yarn, or the React Native build toolchain.
- **Choose isolated** if RN code and native code live in separate repositories or release on independent cadences.
- **Choose integrated** if a single team owns both the native and RN code and is willing to add React Native + Expo to the native project's Gradle and CocoaPods setup.
- Both approaches support Metro and Fast Refresh in Debug. Choose integrated for shared build ownership, not because isolated lacks live JS iteration.

## References

- ./references/brownfield-isolated.md -- Build RN as AAR/XCFramework and consume from the native app (BrownfieldActivity, ReactNativeViewController, ReactNativeView)
- ./references/brownfield-integrated.md -- Add RN and Expo directly to existing Gradle and CocoaPods builds, preserving the native app shell
- ./references/feature-integration.md -- Pass input, return results, dismiss, clean up listeners, and forward lifecycle events; includes a SwiftUI host example
- ./references/comparison.md -- Decision criteria, trade-offs, and scenario mapping for choosing an approach
- ./references/troubleshooting.md -- Metro connection, build, signing, and module-resolution issues common to both approaches

More information available at https://docs.expo.dev/brownfield/overview/

## Shared prerequisites

Both approaches require, in the environment that _builds_ the React Native side:

- **Node.js (LTS)** — runs the Expo CLI and JavaScript code.
- The project's package manager and lockfile — npm, Yarn, pnpm, or Bun. Do not switch package managers just to follow an example.

The iOS build environment needs Xcode and CocoaPods (use the project's Gemfile/Bundler setup when present). The isolated consuming app needs Xcode but no CocoaPods or RN tooling just to consume the artifacts.

## Select compatible versions

For an existing Expo/RN project, keep its selected SDK and use `npx expo install` to align dependencies. Do not upgrade it just to follow this skill. For a new producer, use the **current stable SDK** compatible with the host's OS support, dependencies, and build toolchain; confirm the release is stable before selecting it.

Before native setup, read [./references/version-compatibility.md](./references/version-compatibility.md) for matching native templates, toolchain/OS requirements, and build defaults across SDK versions. A purely native consumer has no Expo SDK version to pin, but must satisfy the artifact's requirements.

## Verify the feature in the host

Open the RN screen with input, return a result to native, dismiss, and reopen with fresh input. Check listener cleanup and the host's original navigation. Then build the host in Release with a Release artifact and Metro stopped. Rendering only in Expo Go or the producer's example app does not validate the integration. See [./references/feature-integration.md](./references/feature-integration.md) for the complete acceptance scenario.

## Submitting Feedback
If you encounter errors, misleading or outdated information in this skill, report it so Expo can improve:
```bash
npx --yes @expo/agent-cli@latest feedback --category skills --subject "expo-brownfield" "<actionable feedback>"
```
Only submit when you have something specific and actionable to report. Include as much relevant context as possible.
If an agent repeatedly fails at an Expo task or the user has to step in, submit a brief report of the task, expected result, and what went wrong using `--category evals` and the relevant Expo package or command as `--subject`.
