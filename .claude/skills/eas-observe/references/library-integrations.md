# Report problems from library integrations

This reference is for **app developers** who want EAS Observe to report problems that a library detects. These built-in integrations do this:

- **Expo Image** (`'expo-image'`): logs an `expo-image.oversized` event when an image is decoded at a much larger size than the screen can display.
- **Reanimated** (`'react-native-reanimated'`): reports Reanimated errors as `reanimated.error` errors, and optionally Reanimated warnings as `reanimated.warning` events.

These integrations do not record metrics. Their reports are user-defined events and errors, so query them with `eas observe:events` and `eas observe:errors` (see [`./queries.md`](./queries.md)). For the per-route navigation metrics from the Expo Router and React Navigation integrations, see [`./setup.md`](./setup.md). To build an integration inside a library, see [`./third-party.md`](./third-party.md).

Both integrations need `expo-observe` set up first (see [`./setup.md`](./setup.md)). Enable them in the same `Observe.configure()` call as any other integration, at module scope, before the app mounts:

```tsx
// app/_layout.tsx
import { Observe } from 'expo-observe';

Observe.configure({
  integrations: {
    'expo-router': true,
    'expo-image': true,
    'react-native-reanimated': true,
  },
});
```

`configure()` replaces the full configuration. Pass every integration that the app uses in each call.

## Expo Image

Docs: https://docs.expo.dev/eas/observe/integrations/expo-image/

**Requirements:** `expo-image` 57.0.2 or later (SDK 57+). If `expo-observe` is not installed, the integration does nothing. Only images loaded through `expo-image` are reported.

On every image load, the integration compares the decoded pixel area with the physical pixel count of the screen. When the area is larger than the screen's pixel count by more than `oversizeThreshold`, it logs an `expo-image.oversized` event with `warn` severity. Each image URL is reported at most once per app session.

**Options:**

| Option | Type | Default | What it does |
|---|---|---|---|
| `oversizeThreshold` | number | `1.5` | Report an image when its decoded pixel area is larger than the screen's physical pixel count by more than this factor. |
| `includeUrlParams` | boolean | `false` | Report the query string and fragment of the URL. Leave it `false` when the URLs can carry tokens or API keys. |

```tsx
Observe.configure({
  integrations: { 'expo-image': { oversizeThreshold: 2 } },
});
```

**Event attributes:** `url` (sanitized), `urlSanitized` (whether sanitization changed the URL), `imageWidth` and `imageHeight` (decoded pixels), `screenWidth` and `screenHeight` (points), and `pixelRatio`.

**URL sanitization:** basic-auth credentials are always removed. The query string and fragment are removed unless `includeUrlParams` is `true`. Only `http(s)`, `file`, and `android.resource` URLs are reported. Other schemes, such as `data:` and `ph://`, are never sent.

**Platform differences** for the `<Image>` component:

- On Android, `<Image>` downscales to the component size at decode time, so a large source in a small component is usually not reported.
- On iOS, the integration sees the decoded size of the source before downscaling, so a large source in a small component is reported, also with `allowDownscaling`.
- `useImage` and `Image.loadAsync` decode at the full source size on both platforms, unless the `maxWidth` and `maxHeight` load options are set.

**Fix reported images:** serve images close to their display size, for example resized variants from an image CDN. With `useImage`, set `maxWidth` and `maxHeight` to downscale at decode time.

```bash
eas observe:events expo-image.oversized
```

## Reanimated

Docs: https://docs.expo.dev/eas/observe/integrations/react-native-reanimated/

**Requirements:** `react-native-reanimated` 4.7.0 or later (SDK 58+), and an `expo-observe` version that includes the integration. The integration uses the `onLog` callback of `configureReanimatedLogger`, which Reanimated 4.7.0 added. With an earlier Reanimated, or without Reanimated, the integration prints a console warning and does nothing. `react-native-reanimated` is an optional peer dependency of `expo-observe`, and it is loaded only when the integration is on.

**Do not call `configureReanimatedLogger` in the app.** The integration calls it itself:

- A call after `Observe.configure()` removes the integration's callback, and reporting stops.
- A call before `Observe.configure()` loses its `level` and `strict` options, because the integration replaces them.

To set those options, pass them to the integration. If the app already calls `configureReanimatedLogger`, move its options into the integration config and delete the call.

**Options:**

| Option | Type | Default | What it does |
|---|---|---|---|
| `level` | `ReanimatedLogLevel.warn` or `ReanimatedLogLevel.error` | `ReanimatedLogLevel.warn` | The minimum log level that Reanimated prints and reports. |
| `strict` | boolean | `true` | Whether Reanimated also prints and reports its strict-mode warnings. |
| `reportWarnings` | boolean | `false` | Also report Reanimated warnings as `reanimated.warning` events. |

```tsx
import { Observe } from 'expo-observe';
import { ReanimatedLogLevel } from 'react-native-reanimated';

Observe.configure({
  integrations: {
    'react-native-reanimated': {
      level: ReanimatedLogLevel.warn,
      strict: true,
      reportWarnings: true,
    },
  },
});
```

**What it reports:**

- A Reanimated error becomes a non-fatal error named `reanimated.error`. It appears on the **Observe > Errors** page with the other errors. On the React Native runtime, the stack trace starts in Reanimated's logger and then includes the code that called the logger. On the UI runtime, the error has the message but no stack trace.
- When `reportWarnings` is `true`, a Reanimated warning becomes a `reanimated.warning` event with `warn` severity. The `message` attribute holds the first 500 characters of the warning.
- Reanimated still prints all errors and warnings to the console.

**Limits:** some messages, such as `measure()` warnings, can repeat on every frame. In each 15-minute period, each distinct message is reported at most once, and at most 20 distinct errors and 20 distinct warnings are reported. Errors and warnings have separate limits. Messages are compared by their first 500 characters.

**Turn it off:** call `Observe.configure()` again without `'react-native-reanimated'`. Reporting stops, and Reanimated's logger keeps its `level` and `strict` options. This is different from the navigation integrations, which throw when their flag changes after mount. So a later `configure()` call must keep the same navigation integration flags.

```bash
# Errors, including reanimated.error
eas observe:errors

# Warnings, when reportWarnings is true
eas observe:events reanimated.warning
```
