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

To start a build from GitHub, run the **OpenBot Mobile build** workflow (Actions, then OpenBot
Mobile build, then Run workflow). Pick the branch to build, a profile and a platform. It starts
the same build as a robot user and prints the link.

The first Android build, and the first iOS build for a phone, must be started by a person from a
terminal. EAS asks then to create the Android keystore and the iOS certificate, and it keeps both.
After that the workflow builds without questions.

## Builds for the stores

The `production` profile makes the build the stores take: an `.aab` for Google Play and an `.ipa`
for the App Store. Start it from the same workflow, with the `production` profile. That run uses
the `mobile-release` environment: a reviewer approves it first, and it starts only from `main` or
`mobile`.

Turn **submit** on, and Expo uploads the build when it is done: to TestFlight on iOS, and to the
internal testing track on Google Play. Nobody outside the team gets the app from there. A release
to the public is made by hand, in App Store Connect and in the Play Console.

Expo holds what an upload needs. This repository holds none of it.

| Store | What Expo holds | What `eas.json` says |
| --- | --- | --- |
| App Store | An App Store Connect API key, the distribution certificate, the provisioning profile and the push key. | `submit.production.ios`: `ascAppId`, the number of the app's record in App Store Connect, and `appleTeamId`. Not set yet. |
| Google Play | The upload keystore, and the key of a Google service account that may release to testing tracks. | `submit.production.android`: the `internal` track. |

Add or replace a key with `eas credentials`, from a terminal. Expo takes no new key from a run
that cannot ask questions, so the workflow cannot do it.

Until `ascAppId` is in `eas.json`, an upload for iOS stops before the build starts and says so.
Google Play takes no upload from Expo until the app has its first release, which a person uploads
by hand in the Play Console.

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

## Updates without a store release

EAS Update sends new JavaScript to the apps people have installed. An app looks for an update when
it starts, downloads it in the background, and runs it the next time it starts.

An update reaches an app only when two things are the same for both:

- **The channel.** A `preview` build takes updates from the `preview` channel, and a `production`
  build from `production`. `eas.json` gives each build its channel.
- **The runtime version.** Expo computes it from the native side of the app: the native modules,
  the config plugins, the app config and `eas.json`. A change to a screen keeps it. A new native
  dependency changes it, and then the installed apps need a new build. Nobody sets it by hand.
  `fingerprint.config.js` says what is left out of it.

On Android the Firebase settings file is part of the runtime version. Publish an update for Android
only from a checkout that has the same `google-services.json` the build had (see Push notifications
on Android). Without the file the update gets another runtime version, and no installed app takes
it.

To see the runtime version of your checkout:

```sh
npx expo-updates runtimeversion:resolve --platform ios
```

To publish an update to the `preview` channel:

```sh
eas update --channel preview --message "What changed"
```

Try every update on a real phone with a `preview` build before it goes further.

Do not publish to `production` from your machine. An update is bundled on the machine that
publishes it, so it takes `EXPO_PUBLIC_SERVER_URL` from that machine's `.env`. The workflow that
publishes to `production` is not set up yet.

A `development` build takes no updates. It loads its JavaScript from your machine.

Not set up yet: the workflow that publishes updates.
