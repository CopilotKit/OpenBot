import "../global.css";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { useFonts } from "expo-font";
import * as Notifications from "expo-notifications";
import { router, Stack, usePathname } from "expo-router";
import { HeroUINativeProvider } from "heroui-native/provider";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { Drawer } from "react-native-drawer-layout";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useCSSVariable } from "uniwind";
import { setSignedInPerson } from "../src/api";
import { AppMenu, SECTIONS } from "../src/app-menu";
import { authClient } from "../src/auth";
import { DrawerProvider, useDrawer } from "../src/drawer";
import { withSecurityFloor } from "../src/floor-gate";
import {
  MenuButton,
  NO_HEADER_LEFT,
  plainBackButton,
  plainHeaderLeft,
} from "../src/header";
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

/** The native header in the scheme's colors and Inter, for every screen. */
function useHeaderOptions() {
  const [background, foreground] = useCSSVariable([
    "--color-background",
    "--color-foreground",
  ]) as (string | undefined)[];
  return {
    headerBackTitle: "Back",
    headerShadowVisible: false,
    headerTintColor: foreground,
    headerStyle: { backgroundColor: background },
    headerTitleStyle: { fontFamily: "Inter_600SemiBold", color: foreground },
    headerLargeTitleStyle: { fontFamily: "Inter_700Bold", color: foreground },
    headerLargeTitleShadowVisible: false,
    contentStyle: { backgroundColor: background },
    // A pushed screen's way back, as a plain chevron (../src/header.tsx).
    ...plainBackButton(),
  } as const;
}

/** A top section of the app: a large title, and the menu button where a back button would be. */
const section = (title: string) =>
  ({
    title,
    headerLargeTitle: true,
    ...plainHeaderLeft(() => <MenuButton />),
  }) as const;

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
  const drawer = useDrawer();
  const pathname = usePathname();
  const backdrop = useCSSVariable("--color-backdrop") as string | undefined;
  // The menu swipes in only on a section's own screen: deeper in, the same swipe is the way back.
  const atSection = SECTIONS.some((item) => item.href === pathname);
  if (!answered.current) return <View className="flex-1 bg-background" />;
  return (
    <View className="flex-1 bg-background">
      <Drawer
        open={signedIn && drawer.open}
        onOpen={() => drawer.setOpen(true)}
        onClose={() => drawer.setOpen(false)}
        renderDrawerContent={() => <AppMenu />}
        drawerType="front"
        swipeEnabled={signedIn && atSection}
        drawerStyle={{ width: 300 }}
        overlayStyle={{ backgroundColor: backdrop }}
      >
        <Stack screenOptions={header}>
          {/*
           * Each guard says where it sends a person. Without one, expo-router picks the first screen no guard
           * covers by file name, which is the gallery: a signed-out start opened there rather than on Welcome.
           */}
          <Stack.Protected guard={signedIn} redirectTo="/sign-in">
            <Stack.Screen name="index" options={section("Conversations")} />
            <Stack.Screen name="bots" options={section("Bots")} />
            <Stack.Screen name="routines" options={section("Routines")} />
            <Stack.Screen name="memory" options={section("Memory")} />
            <Stack.Screen name="skills" options={section("Skills")} />
            <Stack.Screen name="connections" options={section("Connections")} />
            <Stack.Screen name="conversation" options={{ title: "" }} />
            <Stack.Screen name="bot" options={{ title: "" }} />
            <Stack.Screen
              name="account"
              options={{
                title: "Your account",
                presentation: "formSheet",
                ...NO_HEADER_LEFT,
                sheetAllowedDetents: [0.6, 1],
                sheetGrabberVisible: true,
              }}
            />
            <Stack.Screen
              name="new-conversation"
              options={{
                title: "New conversation",
                presentation: "formSheet",
                ...NO_HEADER_LEFT,
                sheetAllowedDetents: [0.6, 1],
                sheetGrabberVisible: true,
              }}
            />
            <Stack.Screen
              name="new-bot"
              options={{
                title: "New Bot",
                presentation: "formSheet",
                ...NO_HEADER_LEFT,
                sheetAllowedDetents: [1],
                sheetGrabberVisible: true,
              }}
            />
            <Stack.Screen
              name="approvals"
              options={{ title: "Approval inbox" }}
            />
            <Stack.Screen name="needs-you" options={{ title: "Needs you" }} />
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
      </Drawer>
      <VersionGate verdict={verdict} onRetry={() => void check()} />
    </View>
  );
}

const SecuredLayout = withSecurityFloor(Layout);

export default function RootLayout() {
  // Inter, the web app's face, at the four weights the type scale uses (global.css names them).
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
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
              <DrawerProvider>
                <SecuredLayout />
              </DrawerProvider>
            </HeroUINativeProvider>
          </KeyboardProvider>
        )}
      </LaunchProvider>
    </GestureHandlerRootView>
  );
}
