# OpenBot Mobile

OpenBot for iOS and Android. It is an Expo app (React Native, Expo Router) and it talks to OpenBot
Cloud.

- What the app is for, and the stack it is built with:
  [docs/app-guidelines.md](../docs/app-guidelines.md).
- The rules for changing it: [AGENTS.md](AGENTS.md).

This folder is an npm package of its own. It is not one of the repository's Bun workspaces, so use
`npm` here, and commit `package-lock.json` with every dependency change.

## Run it on your machine

You need Node 22 or newer. For iOS you need Xcode. For Android you need Android Studio and an
emulator.

```sh
cd mobile
npm ci
cp .env.example .env
npm run ios        # or: npm run android
```

The first run writes the native projects (`ios/` and `android/`, which git ignores), compiles the
app and opens it in the simulator. That takes several minutes. After that, `npm start` starts only
the JavaScript server, and the installed app reloads as you edit.

Run `npm run ios` or `npm run android` again after you add a native dependency or change
`app.config.ts`.

The app is on Expo SDK 58, which builds with Xcode 27.

`.env` holds the address of the OpenBot the app talks to: OpenBot Cloud's API,
`https://api.open.bot`.

Add a dependency with `npx expo install <name>`. It picks the version this Expo SDK was built with.

## Checks

```sh
npm run typecheck   # TypeScript
npm run doctor      # Expo's own checks of the project
npm run bundle      # the JavaScript both phones load, built the way a release builds it
```

A pull request that touches `mobile/` runs all three in CI, as the check `native types`. The app's
tests are in `tests/` and run with the repository's suite: `bun test` from the repository root.

`npm run doctor` also compares the installed packages with Expo's newest patch versions. CI leaves
that one comparison out, so a patch that Expo publishes does not fail a pull request that changed
nothing. When it fails on your machine, `npx expo install --check` updates the packages.

## Builds on Expo

Expo's build service, EAS Build, compiles and signs the app on Expo's machines. The builds belong
to the OpenBot project in CopilotKit's Expo organization, and each one is listed on expo.dev with
a link to install it. `eas.json` holds the build profiles:

| Profile | What it builds | Use it for |
| --- | --- | --- |
| `development` | The app with the developer menu. It loads its JavaScript from your machine. | Work on a real phone. |
| `development-simulator` | The same, for the iOS simulator. | A simulator, with no local compile. |
| `preview` | The app as people will get it, installed from a link. | A try of a change before the stores. |
| `production` | The build for the App Store and Google Play. | A release. |

Every profile builds the app for OpenBot Cloud.

To start a build from your machine, you must be a member of the Expo organization:

```sh
npm install --global eas-cli
eas login
eas build --profile development --platform ios
```

An iOS `development` or `preview` build installs only on phones the project knows. Register a
phone with `eas device:create`, then build.

To start a build from GitHub, run the **OpenBot Mobile build** workflow (Actions, then OpenBot Mobile
build, then Run workflow) and pick a profile and a platform. It starts the same build as a robot user and
prints the link.

The first Android build, and the first iOS build for a phone, must be started by a person from a
terminal. EAS asks then to create the Android keystore and the iOS certificate, and it keeps both.
After that the workflow builds without questions.

## Push notifications on Android

Android gets its push token through Firebase, from the Firebase project `openbot-e63ea`. Expo keeps
two things from it:

- `google-services.json`, the Android app's Firebase settings, in the EAS file variable
  `GOOGLE_SERVICES_JSON`. `app.config.ts` reads it there. To build on your machine with
  notifications, download the file from the Firebase console (Project settings, then the Android
  app `ai.openbot.mobile`) into `mobile/`. Git ignores it.
- The Firebase service account key, in the project's Android credentials (FCM V1), so that Expo's
  push service can reach Android phones. Never commit it.

iOS push uses the key Expo created with the first iOS build.

Not set up yet: updates sent to installed apps without a store release, and uploads to the stores.
