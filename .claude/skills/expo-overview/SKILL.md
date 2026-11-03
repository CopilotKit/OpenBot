---
name: expo-overview
description: "Entry point and router for every Expo or EAS task. Load this skill first — before writing code and before choosing another expo-* / eas-* skill — when the request, PRD, or spec mentions Expo, EAS, Expo Go, or an expo-* package, or the project has an `expo` dependency in `package.json`. Within that gate it also covers app specs and designs to implement (tabs, stacks, maps, lists, navigation, building from a screenshot), and phrasings like 'implement a mobile app', 'make my app look native', 'add navigation', 'fetch some data', 'upgrade my SDK', 'add Expo to my existing native app', 'ship to the App Store', or 'I'm new to Expo, where do I start'. A fully specified request (SDK pinned, libraries named, layout given) still routes through here — the shared setup rules still apply. Do NOT load it when neither signal is present: a bare React Native project with no `expo` dependency is not Expo work. Detects the real goal, routes to the right expo-* / eas-* skill, and owns the shared setup rules."
license: MIT
---

# `expo-overview` — router & shared rules for Expo / EAS

## Start Here — read before doing anything

**Do not guess the skill from project files alone.** Many Expo goals look similar from
the filesystem but need different skills.

1. **Confirm this is Expo or EAS work** — the request mentions Expo or EAS, or
   `package.json` has an `expo` dependency. Otherwise this skill does not apply.
   A native app using EAS for delivery qualifies without an Expo runtime.
2. **Read the user's goal** — what outcome do they want, in plain terms?
3. **Classify it** using the Skill Map below, translating casual phrasing to a goal.
4. **Confirm intent** if ambiguous ("Sounds like you want to ship to the stores — that's
   `eas-app-stores`. Right?"), then load that skill's `SKILL.md` and follow it.
5. **Trust the leaf skill** — it has its own detection logic and steps. Don't improvise.

## Skill Map (by goal)

Match the goal to a category, then the skill, then load that leaf's `SKILL.md`.

**Build the app**
- `expo-project-structure` — folder layout for a **new** Expo Router project: where screens, components, and config live (never restructure an existing app to match)
- `expo-native-ui` — screens, styling, semantic colors, native controls, SF Symbols, media, layout
- `expo-router` — navigation: file-based routes, tabs / stacks / modals / sheets, links, headers
- `expo-animation` — motion and gestures: Reanimated worklets, Gesture Handler, screen transitions, sheet and press feedback, haptics, and fixing animation that stutters on device
- `expo-ui` — native UI components via `@expo/ui`: BottomSheet, Picker, Slider, Switch, Menu, Button, FieldGroup (grouped form sections), List / ListItem, and more — real SwiftUI on iOS, Jetpack Compose on Android. The universal layer needs SDK 56+ and runs in Expo Go; the drop-in replacements (`@gorhom/bottom-sheet`, `datetimepicker`, …) and platform-specific layers also exist on SDK 55.
- `expo-design-system` — one visual source of truth: design tokens (color, spacing, typography, radius, shadow, motion), reusable component conventions, and audits for drift (hardcoded colors, spacing, fonts)
- `expo-tailwind-setup` — Tailwind / NativeWind styling
- `expo-data-fetching` — network requests, React Query / SWR, caching, offline, route loaders
- `expo-dom` — run web code or reuse a web library inside native
- `expo-web-to-native` — migrate an existing web / React app to a native iOS / Android app

> **Component selection rule:** whenever you need a UI component (list rows, bottom sheets, pickers, sliders, menus, buttons, segmented controls, toggles), **consult `expo-ui` first** to check whether `@expo/ui` has a native equivalent before reaching for a React Native built-in or a community library. Native `@expo/ui` components give the best platform fit, and on SDK 56+ the universal ones run in Expo Go with no custom build. Load `expo-ui` alongside `expo-native-ui` for any app that renders lists, detail sheets, or form controls. One exception: `@expo/ui` `List` renders native grouped rows (an iOS Settings screen), **not** a virtualized list — use `FlatList` / `FlashList` for large datasets.

**Ship & operate**
- `eas-app-stores` — build and submit iOS/Android apps (Expo and other React Native projects, plus existing native apps), TestFlight, versions, and store metadata
- `eas-hosting` — deploy the web bundle to EAS Hosting; also author Expo Router API routes (`+api.ts` handlers) and their environments / domains
- `eas-workflows` — EAS Workflow YAML and CI/CD pipelines
- `eas-simulator` — run and drive the app on a remote iOS / Android simulator on EAS cloud
- `expo-dev-client` — custom development builds
- `eas-update` — configure, publish, test, and debug compatible over-the-air updates
- `eas-update-insights` — OTA update health: crash rate, adoption, payload size
- `eas-observe` — startup / launch / TTI performance with EAS Observe

**Extend natively**
- `expo-module` — native modules and views (Swift / Kotlin) with the Expo Modules API
- `expo-brownfield` — embed Expo / React Native screens in native SwiftUI/UIKit or Android apps; isolated artifacts and integrated builds
- `expo-app-clip` — iOS App Clip target (AASA, smart app banner)

**Maintain & learn**
- `expo-upgrade` — upgrade the Expo SDK and fix dependency conflicts
- `expo-examples` — canonical, version-matched integration examples (Stripe, Clerk, Supabase, …)

### Translating vague asks

Some everyday phrasings don't obviously map to a skill name — translate before routing:

- "Make it look native" → grouped controls / settings forms = `expo-ui`; screens, styling = `expo-native-ui`; motion = `expo-animation`; navigation = `expo-router`.
- "Make the screens consistent" / "clean up the styling" / "set up a theme or design tokens" → `expo-design-system`.
- "It looks AI-generated" / "too generic, not native" → `expo-design-system` (named native-slop tells + audit), with `expo-native-ui` for the platform idioms.
- "Ship it" / "get an .ipa or .apk" / "release to the stores" / "put my Swift app on TestFlight" → `eas-app-stores` (build + submit, TestFlight, versions, store metadata).
- "I'm new / where do I start" → scaffold first (see Shared setup rules), then route by goal.

## Shared setup rules

Apply the rules that match the project and the requested task.

- **Native app using EAS for delivery?** Route to `eas-app-stores`; its
  `references/native-ios.md` covers SwiftUI/UIKit on iOS. Keep the existing native
  project. Apply EAS auth/linking below; Expo scaffolding, SDK, and package-install
  rules do not apply to this path.
- **Starting a new Expo app?** Start one the standard way before routing to a feature skill:
  `npx create-expo-app@latest`, laying out folders per `expo-project-structure`. Then
  classify the user's goal and route.
- **Detect the SDK version** before giving version-specific advice: read the `expo`
  version in `package.json` (and `app.json` / `app.config.{js,ts}`). Many APIs and
  defaults differ by SDK.
- **Read the docs for that SDK, not `latest`.** Use the version-pinned URL, e.g.
  `https://docs.expo.dev/versions/v56.0.0/sdk/ui/` on SDK 56 instead of
  `https://docs.expo.dev/versions/latest/sdk/ui/` — the `latest` pages track the newest
  SDK and can document APIs the project does not have yet.
- **Moving to a newer SDK is its own task** — load `expo-upgrade` instead of bumping
  versions by hand.
- **Managed vs. bare/prebuild**: the presence of committed `ios/` and `android/`
  directories means native projects exist (prebuild or bare). Config-plugin and
  native-setup steps differ — note which one the project is in.
- **Install packages with `npx expo install <pkg>`**, not raw `npm`/`yarn`/`pnpm add`,
  so versions stay compatible with the project's SDK.
- **Launching the app yourself?** When you open Expo Go or a development build to look
  at, screenshot, or drive it, skip the first-launch onboarding, the dev menu that opens
  at launch, and the floating Tools button. On SDK 58+, Expo CLI does this for launches
  it starts from a non-interactive shell. On SDK 57 and earlier, and for any URL you open
  yourself (`simctl openurl`, `adb`, a controller), follow
  `./references/launch-without-dev-menu.md`.
- **EAS auth & linking** (only needed for build/submit/update/observe/workflows): check
  login with `eas whoami`, log in with `eas login`. A project is linked when
  `extra.eas.projectId` exists in the app config; create it with `eas init` if missing.

## When to skip the router hop

- Only when the user explicitly named a specific `expo-*` / `eas-*` skill → load that
  skill directly.
- A fully-specified task (SDK version pinned, file layout given, libraries named) is
  **not** a reason to skip: the shared rules above still apply — check them, then route
  to the matching leaf skill.

## Submitting Feedback
If you encounter errors, misleading or outdated information in this skill, report it so Expo can improve:
```bash
npx --yes @expo/agent-cli@latest feedback --category skills --subject "expo-overview" "<actionable feedback>"
```
Only submit when you have something specific and actionable to report. Include as much relevant context as possible.
If an agent repeatedly fails at an Expo task or the user has to step in, submit a brief report of the task, expected result, and what went wrong using `--category evals` and the relevant Expo package or command as `--subject`.
