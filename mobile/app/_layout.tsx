import "../global.css";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_400Regular_Italic } from "@expo-google-fonts/inter/400Regular_Italic";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { useFonts } from "expo-font";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { HeroUINativeProvider } from "heroui-native/provider";
import { useEffect, useRef } from "react";
import { Platform, StatusBar, useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { setSignedInPerson } from "../src/api";
import { authClient } from "../src/auth";
import { withSecurityFloor } from "../src/floor-gate";
import { NO_HEADER_LEFT, useHeaderOptions } from "../src/header";
import {
  LaunchProvider,
  useLaunchExpectsOrb,
  useLaunchSettled,
} from "../src/launch";
import { notificationDestination } from "../src/links";
import { renewPush } from "../src/notifications";
import { aboutShownConversation } from "../src/on-screen";
import { onSessionRefused } from "../src/session-refused";
import { useVersionVerdict, VersionGate } from "../src/version-gate";

Notifications.setNotificationHandler({
  // One about the conversation on screen shows nothing: the screen has it, and refreshes to show it.
  handleNotification: async (notification) => {
    const show = !aboutShownConversation(notification.request.content.data);
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: false,
    };
  },
});

/**
 * How a sheet opens. iOS: the system's page sheet, with its grabber and swipe to put it away (iOS's
 * form sheet leaves its content unlaid-out on this React Native Screens). Android: Material's bottom
 * sheet, with its corners, its handle and title drawn by the screen (`SheetTitle`).
 */
const SHEET =
  Platform.OS === "ios"
    ? ({ presentation: "modal", ...NO_HEADER_LEFT } as const)
    : ({
        presentation: "formSheet",
        ...NO_HEADER_LEFT,
        sheetGrabberVisible: true,
        sheetCornerRadius: 28,
      } as const);

function Layout() {
  const { data: session, isPending, refetch } = authClient.useSession();
  // Who is signed in, said before anything below asks for their organization: each person's pick is their own.
  setSignedInPerson(session?.user.id);
  // A signed-in request refused as signed out: the session is read again, and one that is gone shows the sign-in.
  useEffect(() => onSessionRefused(() => void refetch()), [refetch]);
  // Asked before sign-in: whether this app and its OpenBot can work together. When they can't, one sentence covers
  // the app, so no screen behind it is seen failing.
  const { verdict, check } = useVersionVerdict(Boolean(session), isPending);
  // A phone that gets notifications sends its current push token each time the app starts signed in.
  useEffect(() => {
    if (session) void renewPush().catch(() => {});
  }, [session]);
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
  const signedIn = Boolean(session);
  /*
   * The screens wait for the first answer about the session. Drawn while it is still pending, the signed-in
   * screens are guarded out, the app opens on a screen outside the guards (the gallery, in a development build),
   * and stays there once the session arrives; an address the app was opened at is lost the same way. Only the
   * first answer is waited for: a sign-in pending later keeps the screens where they are.
   */
  const answered = useRef(false);
  if (!isPending) answered.current = true;
  // The launch cover (src/launch.tsx) stays over the app until this answer, and the version check's, are in.
  useLaunchSettled("session", answered.current);
  useLaunchExpectsOrb(answered.current ? !signedIn : undefined);
  useLaunchSettled(
    "version",
    verdict !== "checking",
    verdict !== "checking" && verdict.kind !== "ok",
  );
  const header = useHeaderOptions();
  // The status bar's clock and icons in the text color: dark on the light scheme, light on the dark. Android draws
  // them light on its own, which on OpenBot's light background could hardly be read.
  const scheme = useColorScheme();
  const statusBar = (
    <StatusBar
      barStyle={scheme === "dark" ? "light-content" : "dark-content"}
    />
  );
  if (!answered.current)
    return <View className="flex-1 bg-background">{statusBar}</View>;
  return (
    <View className="flex-1 bg-background">
      {statusBar}
      <Stack screenOptions={header}>
        {/*
         * Each guard says where it sends a person. Without one, expo-router picks the first screen no guard
         * covers by file name, which is the gallery: a signed-out start opened there rather than on Welcome.
         */}
        <Stack.Protected guard={signedIn} redirectTo="/sign-in">
          {/* The tabs, in the platform's tab bar: everything below opens over them. */}
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="conversation" options={{ title: "" }} />
          <Stack.Screen name="bot" options={{ title: "" }} />
          <Stack.Screen
            name="new-conversation"
            options={{
              title: "New conversation",
              ...SHEET,
              sheetAllowedDetents: [0.6, 1],
            }}
          />
          <Stack.Screen
            name="new-bot"
            options={{ title: "New Bot", ...SHEET, sheetAllowedDetents: [1] }}
          />
          <Stack.Screen
            name="approvals"
            options={{ title: "Approval inbox" }}
          />
          <Stack.Screen name="computer" options={{ title: "Computer" }} />
          <Stack.Screen name="routine" options={{ title: "Routine" }} />
          <Stack.Screen name="rules" options={{ title: "Custom rules" }} />
          <Stack.Screen name="plugins" options={{ title: "Apps" }} />
          {/* Only the way back to Home after linking the company account: never seen, so no header flashes. */}
          <Stack.Screen
            name="company-sign-in/linked"
            options={{ headerShown: false, animation: "none" }}
          />
        </Stack.Protected>
        {/* Only the way back to Home after signing in, for a code that arrived outside the browser's session. */}
        <Stack.Screen
          name="oauth/callback"
          options={{ headerShown: false, animation: "none" }}
        />
        {/* The component gallery, in development builds only (app/gallery.tsx). */}
        <Stack.Screen name="gallery" options={{ title: "Components" }} />
        <Stack.Protected guard={!signedIn} redirectTo="/">
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
      <VersionGate verdict={verdict} onRetry={() => void check()} />
    </View>
  );
}

const SecuredLayout = withSecurityFloor(Layout);

export default function RootLayout() {
  // Inter, the web app's face, at the four weights the type scale uses and its italic (global.css names them).
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_400Regular_Italic,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  // A font that fails to load draws in the system face rather than leaving the app blank.
  const fontsReady = fontsLoaded || Boolean(fontError);
  // The launch cover is drawn from the first frame, the fonts or not, so the phone's splash has it to hand over to.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <LaunchProvider fontsReady={fontsReady}>
        {fontsReady && (
          <KeyboardProvider>
            <HeroUINativeProvider
              config={{ devInfo: { stylingPrinciples: false } }}
            >
              <SecuredLayout />
            </HeroUINativeProvider>
          </KeyboardProvider>
        )}
      </LaunchProvider>
    </GestureHandlerRootView>
  );
}
