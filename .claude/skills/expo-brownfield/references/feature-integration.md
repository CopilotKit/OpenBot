# Integrate a complete native-hosted feature

Read after choosing the build approach. Packaging a framework and displaying its first view are only part of integration: the host also owns presentation, input, results, and lifecycle events.

## Define the boundary

- Use initial props for a presentation's input, including a fresh `requestId` to correlate replies. Use JSON-compatible values rather than Swift objects or JS callbacks.
- Use messages for events such as context requests, completed, and cancelled. Subscribe before mounting the feature. Keep required startup data in initial props; a message sent during mounting is not a durable inbox or an acknowledgement that the receiving native emitter is ready. Correlate and acknowledge later updates if delivery matters.
- Keep long-lived business state in its existing owner. If both sides must observe mutable state, inspect the installed `expo-brownfield` shared-state APIs (`useSharedState`, `setSharedStateValue`, and `deleteSharedState`) and native facade. Namespace per-feature keys and clear session data when its owner ends the session. Messages alone do not provide persistent state or delivery guarantees.

## Register the component that receives input

For a small standalone producer, set `package.json`'s `main` to `index.ts` and register a component explicitly. If the scaffold has no TypeScript setup, first run `npx expo install typescript @types/react`:

```ts
import { registerRootComponent } from 'expo';
import Feature from './Feature';

registerRootComponent(Feature); // Registers "main", matching the native examples.
```

Do not overwrite an existing app entry point blindly. A Router-based producer needs an explicit adapter to carry root props into the feature; native `initialProps` are not automatically route parameters.

`Feature.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';
import * as Brownfield from 'expo-brownfield';

export default function Feature({ requestId, userId, greeting: initialGreeting }: {
  requestId: string; userId: string; greeting: string;
}) {
  const [greeting, setGreeting] = useState(initialGreeting);

  useEffect(() => {
    const subscription = Brownfield.addMessageListener((event) => {
      if (event.requestId === requestId && event.type === 'feature.context') {
        setGreeting(String(event.greeting));
      }
    });
    return () => subscription.remove();
  }, [requestId]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <Text>{greeting}: {userId}</Text>
      <Button title="Refresh greeting" onPress={() => Brownfield.sendMessage({
        type: 'feature.request-context', requestId,
      })} />
      <Button title="Done" onPress={() => Brownfield.sendMessage({
        type: 'feature.completed', requestId, selectedId: 'item-42',
      })} />
      <Button title="Cancel" onPress={() => Brownfield.sendMessage({
        type: 'feature.cancelled', requestId,
      })} />
    </View>
  );
}
```

## SwiftUI host: receive the result and dismiss

This example uses **Expo's isolated generated framework**, configured as `MyBrownfield`, with `ReactNativeHostManager.shared.initialize()` already connected to the host's app delegate as in [isolated setup](./brownfield-isolated.md). It adds a feature to the existing SwiftUI view hierarchy; it introduces no app entry point.

```swift
import SwiftUI
import MyBrownfield

private struct FeatureRequest: Identifiable {
  let id = UUID().uuidString
  let userId: String
}

struct FeatureLauncher: View {
  @State private var request: FeatureRequest?
  @State private var listenerId: String?
  @State private var selectedId: String?

  var body: some View {
    VStack {
      Text(selectedId ?? "No selection")
      Button("Open feature") { openFeature(userId: "123") }
    }
    .sheet(item: $request, onDismiss: stopListening) { request in
      ReactNativeView(
        moduleName: "main",
        initialProps: ["requestId": request.id, "userId": request.userId, "greeting": "Hello"]
      )
    }
  }

  private func openFeature(userId: String) {
    guard request == nil else { return }
    stopListening()
    let next = FeatureRequest(userId: userId)
    listenerId = BrownfieldMessaging.addListener { message in
      // Messaging callbacks are not a promise of execution on the UI thread.
      DispatchQueue.main.async {
        guard request?.id == next.id,
              message["requestId"] as? String == next.id,
              let type = message["type"] as? String else { return }
        switch type {
        case "feature.request-context":
          BrownfieldMessaging.sendMessage([
            "type": "feature.context", "requestId": next.id, "greeting": "Updated hello"
          ])
        case "feature.completed":
          guard let value = message["selectedId"] as? String else { return }
          selectedId = value
          closeFeature()
        case "feature.cancelled":
          closeFeature()
        default:
          break
        }
      }
    }
    request = next
  }

  private func closeFeature() {
    stopListening()
    request = nil
  }

  private func stopListening() {
    if let listenerId {
      BrownfieldMessaging.removeListener(id: listenerId)
      self.listenerId = nil
    }
  }
}
```

The same message contract works with UIKit: the presenting coordinator owns the subscription, passes the request as `initialProps`, handles the result on the main thread, then pops or dismisses its controller. Remove the subscription on interactive cancellation and coordinator teardown too. Remove only the listener you own, not every feature's listeners.

For **integrated** builds, install/autolink `expo-brownfield` only if using these APIs. The isolated plugin's generated `BrownfieldMessaging` facade is not automatically present in the host. In `expo-brownfield` 55.0.28 and 57.0.18, `internal import ExpoBrownfield` (matching the generated module provider) exposes `BrownfieldMessagingInternal.shared` with instance `addListener`, `sendMessage`, and `removeListener(id:)` methods. Confirm the installed Swift interface before adapting the example, or keep a small host adapter around that SDK-specific surface. Use the [integrated controller](./brownfield-integrated.md#present-a-react-native-screen) instead of the isolated `ReactNativeView`.

Navigation behavior depends on the native container. In the SDK 55 and 57 wrappers, the generated UIKit controller handles `popToNative()` by popping its navigation controller, while the generated SwiftUI `ReactNativeView` also listens for that event and calls SwiftUI `dismiss()`. A custom integrated controller does not acquire these handlers automatically. The example above lets the host consume a result before closing its sheet. Use either that result/close contract or the wrapper's navigation API for a given action; do not trigger both.

## Forward lifecycle events

Some modules require launch, URL, notification, and application-state callbacks even when a basic RN view renders successfully.

- **iOS:** use `ExpoAppDelegate` forwarding when compatible with the host's delegate. The isolated generated framework exports `ExpoBrownfieldAppDelegate`; the integrated app uses `ExpoAppDelegate` from `Expo`. Preserve existing override behavior and call the superclass. With a required custom superclass, an isolated host can retain a generated `ExpoBrownfieldAppDelegate` helper and forward the relevant delegate methods to it. An integrated host can use `ExpoAppDelegateSubscriberManager` from `ExpoModulesCore` directly, following the installed SDK's interface. Forward each event once. For scene-based URL handling, connect the existing scene/SwiftUI handler to the module's required callback; an app-delegate adaptor alone does not replace scene delivery.
- **Android:** preserve `ApplicationLifecycleDispatcher` calls and the activity lifecycle/back handling from the chosen approach. Exercise configuration changes and native back navigation in the host.

Use the [Expo lifecycle guide](https://docs.expo.dev/brownfield/lifecycle-listeners/) and the installed delegate source to choose callbacks. Test the actual modules in use, including warm/cold deep links or push registration where applicable; a first-screen render does not verify these paths.

## Acceptance scenario

1. Build the existing host and record its native launch/navigation behavior before integration.
2. Build/select the matching Debug artifact (isolated), run Metro in the producer, and open the feature from the native host with identifiable input.
3. Confirm initial input on screen, then use **Refresh greeting** to verify a later native reply. Complete once: native receives one matching result and closes the feature.
4. Reopen with a fresh request ID and different input. Verify no stale result or duplicate callback. Cancel through both the RN button and native swipe/back dismissal; repeat.
5. Build/select the Release artifact and host Release configuration. Stop Metro, launch afresh, and repeat the interaction, including any bundled images/fonts. Check the original native screens and relevant lifecycle callbacks.

For runnable examples of both SwiftUI hosts, see the [iOS brownfield playgrounds](https://github.com/expo/skills/tree/main/tests/fixtures/expo-brownfield).

EAS Build/Submit can distribute the host after this integration works; they do not implement the runtime boundary. EAS Update requires an updates-enabled RN runtime and separate brownfield setup, not just an EAS project ID. Consult the [existing-native-app Update guide](https://docs.expo.dev/eas-update/integration-in-existing-native-apps/) if requested; use the chosen toolchain's setup for isolated artifacts. Updates cannot replace compiled Swift code or add a native module absent from the shipped binary.

Select the matching SDK/API using [version compatibility](./version-compatibility.md). Current reference: [Brownfield API](https://docs.expo.dev/versions/latest/sdk/brownfield/); implementation: [Expo SDK 57 brownfield](https://github.com/expo/expo/tree/sdk-57/packages/expo-brownfield).
