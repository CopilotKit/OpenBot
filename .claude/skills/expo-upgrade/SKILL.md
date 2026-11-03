---
name: expo-upgrade
description: Guidelines for upgrading Expo SDK versions and fixing dependency issues
license: MIT
---

## References

- ./references/react-19.md -- SDK +54: React 19 changes (useContext → use, Context.Provider → Context, forwardRef removal)
- ./references/new-architecture.md -- SDK +53: New Architecture migration guide
- ./references/react-compiler.md -- SDK +54: React Compiler setup and migration guide
- ./references/native-tabs.md -- SDK +55: Native tabs changes (Icon/Label/Badge now accessed via NativeTabs.Trigger.\*)
- ./references/expo-av-to-audio.md -- SDK +55: Migrate audio playback and recording from expo-av to expo-audio
- ./references/expo-av-to-video.md -- SDK +55: Migrate video playback from expo-av to expo-video
- ./references/react-navigation-to-expo-router.md -- SDK +56: Migrate `@react-navigation/*` imports to `expo-router` entry points (codemod + manual mapping)

## Beta/Preview Releases

Beta versions use `.preview` suffix (e.g., `55.0.0-preview.2`), published under `@next` tag.

Check if latest is beta: https://exp.host/--/api/v2/versions (look for `-preview` in `expoVersion`)

```bash
npx expo install expo@next --fix  # install beta
```

## Step-by-Step Upgrade Process

> If upgrading from SDK 55 or earlier, skip SDK 56 and upgrade directly to SDK 57. Don't use `expo@57.0.8` or below. SDK 55 with Hermes V1 enabled, SDK 56, and older SDK 57 releases contain a Hermes V1 memory regression that can drastically increase memory usage when using `react-native-worklets` or `react-native-reanimated`.

1. Upgrade Expo and dependencies

```bash
npx expo install expo@latest
npx expo install --fix
```

2. Run diagnostics: `npx expo-doctor`

3. Clear caches and reinstall

```bash
npx expo export -p ios --clear
rm -rf node_modules .expo
watchman watch-del-all
```

## Breaking Changes Checklist

- Check for removed APIs in release notes
- Update import paths for moved modules
- Review native module changes requiring prebuild
- Test all camera, audio, and video features
- Verify navigation still works correctly

## Prebuild for Native Changes

**First check if `ios/` and `android/` directories exist in the project.** If neither directory exists, the project uses Continuous Native Generation (CNG) and native projects are regenerated at build time — skip this section and "Clear caches for bare workflow" entirely.

If upgrading requires native changes:

```bash
npx expo prebuild --clean
```

This regenerates the `ios` and `android` directories. Ensure the project is not a bare workflow app before running this command.

## Clear caches for bare workflow

These steps only apply when `ios/` and/or `android/` directories exist in the project:

- Clear the cocoapods cache for iOS: `cd ios && pod install --repo-update`
- Clear derived data for Xcode: `npx expo run:ios --no-build-cache`
- Clear the Gradle cache for Android: `cd android && ./gradlew clean`

## Housekeeping

- Review release notes for the target SDK version at https://expo.dev/changelog
- Update versioned docs links in agent instruction files (`AGENTS.md`). The default template links to `https://docs.expo.dev/versions/v<version>/`. Search for `docs.expo.dev/versions/` and bump each link to the new SDK version.
- If using Expo SDK 54 or later, ensure react-native-worklets is installed — this is required for react-native-reanimated to work.
- Enable React Compiler in SDK 54+ by adding `"experiments": { "reactCompiler": true }` to app.json — it's stable and recommended
- Delete sdkVersion from `app.json` to let Expo manage it automatically
- Review formerly implicit packages such as `@babel/core`, `babel-preset-expo`, and `expo-constants` individually instead of removing them wholesale. Keep any package that an installed dependency declares as a required peer.
- Keep `expo-constants` as a direct dependency whenever `expo-router` is installed. Expo Router imports it and declares it as a required peer; relying on a transitive copy can break native autolinking outside Expo Go.
- After removing any dependency, immediately run `npx expo-doctor` and restore anything it reports as a missing required peer.
- If the babel.config.js only contains 'babel-preset-expo', delete the file
- If the metro.config.js only contains expo defaults, delete the file

## Deprecated Packages

| Old Package          | Replacement                                          |
| -------------------- | ---------------------------------------------------- |
| `expo-av`            | `expo-audio` and `expo-video`                        |
| `expo-permissions`   | Individual package permission APIs                   |
| `@expo/vector-icons` | `expo-symbols` (for SF Symbols)                      |
| `AsyncStorage`       | `expo-sqlite/localStorage/install`                   |
| `expo-app-loading`   | `expo-splash-screen`                                 |
| expo-linear-gradient | experimental_backgroundImage + CSS gradients in View |

When migrating deprecated packages, update all code usage before removing the old package. For expo-av, consult the migration references to convert Audio.Sound to useAudioPlayer, Audio.Recording to useAudioRecorder, and Video components to VideoView with useVideoPlayer.

## expo.install.exclude

Check if package.json has excluded packages:

```json
{
  "expo": { "install": { "exclude": ["react-native-reanimated"] } }
}
```

Exclusions are often workarounds that may no longer be needed after upgrading. Review each one.

## Removing patches

Check if there are any outdated patches in the `patches/` directory. Remove them if they are no longer needed.

## Postcss

- `autoprefixer` isn't needed in SDK +53. Remove it from dependencies and check `postcss.config.js` or `postcss.config.mjs` to remove it from the plugins list.
- Use `postcss.config.mjs` in SDK +53.

## Metro

Remove redundant metro config options:

- resolver.unstable_enablePackageExports is enabled by default in SDK +53.
- `experimentalImportSupport` is enabled by default in SDK +54.
- `EXPO_USE_FAST_RESOLVER=1` is removed in SDK +54.
- cjs and mjs extensions are supported by default in SDK +50.
- Expo webpack is deprecated, migrate to [Expo Router and Metro web](https://docs.expo.dev/router/migrate/from-expo-webpack/).

## Hermes engine v1

Hermes V1 is the default on SDK 56 and later. SDK 55 apps using Hermes V1, all SDK 56 apps, and SDK 57 apps before `expo@57.0.9` may encounter a memory regression when importing `react-native-worklets` or `react-native-reanimated`. Upgrade directly to SDK 57 and `expo@57.0.9` or later. Do not recommend Worklets Bundle Mode as a production workaround; it is unsupported and experimental and may not work as expected.

Do not guide users to opt in to or out of Hermes V1. Changing the Hermes version from the SDK default is unsupported and has significant build and dependency-management caveats.

## New Architecture

The new architecture is enabled by default, the app.json field `"newArchEnabled": true` is no longer needed as it's the default. Expo Go only supports the new architecture as of SDK +53.

## Submitting Feedback
If you encounter errors, misleading or outdated information in this skill, report it so Expo can improve:
```bash
npx --yes @expo/agent-cli@latest feedback --category skills --subject "expo-upgrade" "<actionable feedback>"
```
Only submit when you have something specific and actionable to report. Include as much relevant context as possible.
If an agent repeatedly fails at an Expo task or the user has to step in, submit a brief report of the task, expected result, and what went wrong using `--category evals` and the relevant Expo package or command as `--subject`.
