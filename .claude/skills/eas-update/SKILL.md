---
name: eas-update
description: "Configure and use EAS Update for over-the-air JavaScript and asset updates with expo-updates and EAS CLI. Use when setting up OTA updates, running eas update:configure or eas update, publishing to preview/staging/production channels, explaining branches/channels/runtime versions, testing updates, or debugging why an installed build still shows old code. Load for TestFlight, preview, or production updates that do not appear, including questions about cold launches or reopening the app. Not for update health metrics; use eas-update-insights for adoption, crashes, and rollout monitoring."
license: MIT
allowed-tools: "Bash(npx expo *), Bash(npx *eas-cli@*), Bash(eas *)"
---

# EAS Update

> **EAS service - costs apply.** EAS Update is available on the Free plan; publishing and delivery use update, bandwidth, and storage allowances, with higher limits on paid plans. See https://expo.dev/pricing.

Use EAS Update to deliver compatible JavaScript, styling, and asset changes to installed apps without submitting a new native binary. Native-code changes still require a new build.

## Start with the supported configuration path

Before changing anything, inspect `package.json`, the Expo app config, `eas.json` if present, and whether `ios/` or `android/` are tracked. Use what you find when reviewing the CLI's changes:

- Preserve existing dynamic or platform-specific app configuration.
- If `eas.json` exists, preserve its profiles and existing channel assignments. The CLI adds a channel matching the profile name only to build profiles that do not already have one.
- If `eas.json` is absent, do not create it by hand. The CLI may direct the user to run `eas build:configure` separately.
- With tracked native projects, expect the CLI to synchronize the platform's native Update configuration. Without them, expect Continuous Native Generation to apply the native configuration during a later build.

Detect the Expo SDK version before installing packages or interpreting version-specific behavior.

If `expo-updates` is not installed, install the SDK-compatible version:

```bash
npx expo install expo-updates
```

Configure from the project root:

```bash
npx eas-cli@latest update:configure
```

Use `eas update:configure` rather than manually inventing `updates.url`, `runtimeVersion`, native metadata, or build-profile channels. The command understands EAS project linking, Continuous Native Generation, and projects with committed native directories. Review and explain its resulting diff.

If the command cannot proceed because the project is not linked or the user has not authorized the required remote operation, stop after any independently valid package installation and explain what remains. Do not partially reproduce `update:configure` by adding a runtime-version policy, config plugin, update URL, or channels by hand.

For dynamic app config, non-EAS builds, or a command that cannot complete automatically, follow the current setup documentation instead of guessing: https://docs.expo.dev/eas-update/getting-started.md.

## Keep the model straight

- **Build:** the installed native app. It contains native code, an embedded update, a platform, a runtime version, and normally a channel fixed at build time.
- **Update:** a published JavaScript bundle, assets, and metadata for one platform and runtime version.
- **Branch:** an ordered stream of updates. Its newest compatible update is active.
- **Channel:** a stable deployment target embedded in builds. On the server, it points to a branch.
- **Runtime version:** the compatibility boundary between an update and the native code in a build.

A build receives an update only when platform and runtime version match and the build's channel points to the branch containing that update:

```text
installed build (channel: production, runtime: 1.1.1, platform: ios)
  -> production channel
  -> production branch
  -> newest update for runtime 1.1.1 and ios
```

Channels and branches commonly have the same name, but they are separate objects. `eas channel:edit` changes a channel's server-side branch mapping for every build on that channel. It does not change an individual installation's embedded channel.

Use this model to make decisions, but explain only the concepts needed for the user's request rather than reciting the entire model every time.

## Decide whether an update is compatible

Use an update for changes to JavaScript, styling, and bundled assets that the installed native runtime already supports.

Create a new native build when a change adds or modifies native code or native configuration, including most native-library additions and SDK upgrades. Do not work around a runtime mismatch or imply that publishing can add native capabilities to an existing build. See https://docs.expo.dev/eas-update/runtime-versions.md.

Do not change the project's runtime-version policy as an incidental fix. Explain how the current policy affects compatibility; treat changing it as a separate decision because it changes which installed builds can receive future updates.

## Publish deliberately

Check the current CLI help before relying on remembered flags:

```bash
npx eas-cli@latest update --help
```

For the common channel-based flow:

```bash
npx eas-cli@latest update \
  --channel <channel> \
  --message "<message>" \
  --environment <environment>
```

SDK 55 and later require an EAS environment for publishing. Choose the environment intentionally so exported code receives the intended variables.

Publishing changes remote state and can affect installed applications. Before running it, establish the exact project, channel, environment, platforms, runtime version, and message. Publish to production only when the user has explicitly requested or approved it; if the authorization or target is ambiguous, stop before the command and ask. Do not infer a production destination solely from the current Git branch.

Prefer a preview or staging channel for validation. When promoting a tested update, use the documented deployment flow so production receives the same artifact where possible: https://docs.expo.dev/eas-update/deployment.md.

## Test according to the build type

### Development builds

Preview updates with the development build's Extensions UI, the EAS dashboard, or Expo Orbit. A normal `expo-dev-client` development build does not behave like a release build's automatic startup update flow.

### Preview, TestFlight, and production builds

Release builds normally prioritize startup speed. With the default launch behavior, the app may start its current embedded or cached update while downloading a newly published update in the background. The downloaded update is applied on a later restart.

For manual QA, fully terminate the app rather than backgrounding it, reopen it, allow the update time to download, and, if the change is not visible, fully terminate and reopen it once more. Describe this as **up to two cold launches**, not a TestFlight-specific ritual:

1. One launch can discover and download the update.
2. The following launch can run the downloaded update.

Do not automatically change `fallbackToCacheTimeout` to avoid the second launch. Waiting at startup trades launch latency and reliability for faster update activation. If the app needs an intentional update UX, consider the `expo-updates` APIs for checking, fetching, and presenting a non-blocking restart action. Use the `expo-updates` API reference for the project's detected SDK version.

## Debug a build that did not update

Check these in order:

1. Confirm the update was published to the intended EAS project, channel or branch, platform, and environment.
2. Compare the installed build's platform and runtime version with the published update.
3. Confirm the build actually contains the expected update URL and channel; app-config changes take effect only in a newly compiled build.
4. Inspect the channel-to-branch mapping and the active update on that branch.
5. Fully terminate the release build and allow for the normal download-then-apply lifecycle.
6. Use the current debugging guide for native logs, export problems, and configuration checks: https://docs.expo.dev/eas-update/debug.md.

Never bypass a compatibility or anti-bricking safeguard merely to make an update appear.

## Advanced and adjacent workflows

- **Channel surfing:** an individual release build can override its `expo-channel-name` request header to request another compatible channel. This differs from changing the server-side channel-to-branch mapping. Follow https://docs.expo.dev/eas-update/channel-surfing.md and preserve its access-control, persistence, recovery, and compatibility constraints.
- **Update health:** load `eas-update-insights` for adoption, launch failures, crash rate, payload size, and rollout monitoring after publishing.
- **Store releases:** load `eas-app-stores` when native changes require a new TestFlight, App Store, or Play Store build.

## Official references

- Setup: https://docs.expo.dev/eas-update/getting-started.md
- Concepts and matching: https://docs.expo.dev/eas-update/how-it-works.md
- Deployment: https://docs.expo.dev/eas-update/deployment.md
- Debugging: https://docs.expo.dev/eas-update/debug.md
- Current EAS CLI reference: https://docs.expo.dev/eas/cli.md

## Submitting Feedback
If you encounter errors, misleading or outdated information in this skill, report it so Expo can improve:
```bash
npx --yes @expo/agent-cli@latest feedback --category skills --subject "eas-update" "<actionable feedback>"
```
Only submit when you have something specific and actionable to report. Include as much relevant context as possible.
If an agent repeatedly fails at an Expo task or the user has to step in, submit a brief report of the task, expected result, and what went wrong using `--category evals` and the relevant Expo package or command as `--subject`.
