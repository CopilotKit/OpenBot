---
name: expo-dev-client
description: Build and distribute Expo development clients locally or via TestFlight for internal testing. For production TestFlight releases and store submission, use the eas-app-stores skill.
license: MIT
---

Use EAS Build to create development clients for testing native code changes on physical devices. Use this for creating custom Expo Go clients for testing branches of your app.

> **Free locally; cloud builds are paid.** `expo-dev-client` itself is open source and building locally is free. Building or distributing via EAS Build/TestFlight uses your EAS plan's build minutes and needs a paid Apple Developer account for device/TestFlight distribution. See https://expo.dev/pricing.

## Important: When Development Clients Are Needed

**Development clients are the recommended setup for any real or production app.** Expo Go is a playground for learning and quick experiments with the native libraries it bundles; most apps outgrow it and move to a development client. See [Expo Go vs. development builds](https://docs.expo.dev/develop/development-builds/introduction/) for the full reasoning.

You need a dev client ONLY when using:

- Local Expo modules (custom native code)
- Apple targets (widgets, app clips, extensions)
- Third-party native modules not in Expo Go
- Config plugins, or testing remote push notifications and App/Universal Links

## EAS Configuration

Ensure `eas.json` has a development profile:

```json
{
  "cli": {
    "version": ">= 16.0.1",
    "appVersionSource": "remote"
  },
  "build": {
    "production": {
      "autoIncrement": true
    },
    "development": {
      "autoIncrement": true,
      "developmentClient": true
    }
  },
  "submit": {
    "production": {},
    "development": {}
  }
}
```

Key settings:

- `developmentClient: true` - Bundles expo-dev-client for development builds
- `autoIncrement: true` - Automatically increments build numbers
- `appVersionSource: "remote"` - Uses EAS as the source of truth for version numbers

## Building for TestFlight

Build iOS dev client and submit to TestFlight in one command:

```bash
eas build -p ios --profile development --submit
```

This will:

1. Build the development client in the cloud
2. Automatically submit to App Store Connect
3. Send you an email when the build is ready in TestFlight

After receiving the TestFlight email:

1. Download the build from TestFlight on your device
2. Launch the app to see the expo-dev-client UI
3. Connect to your local Metro bundler or scan a QR code

## Building Locally

Build a development client on your machine:

```bash
# iOS (requires Xcode)
eas build -p ios --profile development --local

# Android
eas build -p android --profile development --local
```

Local builds output:

- iOS: `.ipa` file
- Android: `.apk` or `.aab` file

## Installing Local Builds

Install iOS build on simulator:

```bash
# Find the .app in the .tar.gz output
tar -xzf build-*.tar.gz
xcrun simctl install booted ./path/to/App.app
```

Install iOS build on device (requires signing):

```bash
# Use Xcode Devices window or ideviceinstaller
ideviceinstaller -i build.ipa
```

Install Android build:

```bash
adb install build.apk
```

## Building for Specific Platform

```bash
# iOS only
eas build -p ios --profile development

# Android only
eas build -p android --profile development

# Both platforms
eas build --profile development
```

## Checking Build Status

```bash
# List recent builds
eas build:list

# View build details
eas build:view
```

## Using the Dev Client

Once installed, the dev client provides:

- **Development server connection** - Enter your Metro bundler URL or scan QR
- **Build information** - View native build details
- **Launcher UI** - Switch between development servers

Connect to local development:

```bash
# Start Metro bundler
npx expo start --dev-client

# Scan QR code with dev client or enter URL manually
```

When you launch the dev client yourself to screenshot or drive it, skip the onboarding sheet, the dev menu at launch, and the Tools button. On SDK 58+, Expo CLI does this for launches it starts from a non-interactive shell; for a URL you open yourself, use `<scheme>://?__expo_url=<encoded dev server URL>&__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1`. On SDK 57 and earlier, launch the iOS app with the `-EXDevMenu*` launch arguments, and on Android open `<scheme>://expo-development-client/?url=<encoded dev server URL>&disableOnboarding=1&disableFab=1&disableAutoLaunch=1`. See `../expo-overview/references/launch-without-dev-menu.md` for the exact commands.

## Troubleshooting

**Build fails with signing errors:**

```bash
eas credentials
```

**Clear build cache:**

```bash
eas build -p ios --profile development --clear-cache
```

**Check EAS CLI version:**

```bash
eas --version
eas update
```

## Submitting Feedback
If you encounter errors, misleading or outdated information in this skill, report it so Expo can improve:
```bash
npx --yes @expo/agent-cli@latest feedback --category skills --subject "expo-dev-client" "<actionable feedback>"
```
Only submit when you have something specific and actionable to report. Include as much relevant context as possible.
If an agent repeatedly fails at an Expo task or the user has to step in, submit a brief report of the task, expected result, and what went wrong using `--category evals` and the relevant Expo package or command as `--subject`.
