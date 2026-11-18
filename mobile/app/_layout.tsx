import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { authClient } from "../src/auth";
import { notificationDestination } from "../src/links";
import { useVersionVerdict, VersionGate } from "../src/version-gate";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
export default function Layout() {
  const { data: session } = authClient.useSession();
  // Asked before sign-in: whether this app and its OpenBot can work together. When they can't, one sentence covers
  // the app, so no screen behind it is seen failing.
  const { verdict, check } = useVersionVerdict();
  const pending = useRef<unknown>(null);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.current === id) return;
      pending.current = response.notification.request.content.data;
      if (session) {
        const destination = notificationDestination(pending.current);
        if (destination) router.push(destination);
        handled.current = id;
        pending.current = null;
      }
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last);
    const subscription =
      Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [session]);
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerBackTitle: "Back" }}>
        <Stack.Screen name="index" options={{ title: "OpenBot" }} />
        <Stack.Screen name="conversation" options={{ title: "Conversation" }} />
        <Stack.Screen name="approvals" options={{ title: "Approval inbox" }} />
        <Stack.Screen name="needs-you" options={{ title: "Needs you" }} />
        <Stack.Screen name="bots" options={{ title: "Bots" }} />
        <Stack.Screen name="bot" options={{ title: "Bot" }} />
        <Stack.Screen name="computer" options={{ title: "Computer" }} />
        <Stack.Screen name="routine" options={{ title: "Routine" }} />
        <Stack.Screen name="memory" options={{ title: "Memory" }} />
        <Stack.Screen name="rules" options={{ title: "Custom rules" }} />
        <Stack.Screen name="plugins" options={{ title: "Plugins" }} />
      </Stack>
      <VersionGate verdict={verdict} onRetry={() => void check()} />
    </View>
  );
}
