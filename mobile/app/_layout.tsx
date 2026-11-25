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
import { MenuButton } from "../src/header";
import { notificationDestination } from "../src/links";
import { onSessionRefused } from "../src/session-refused";
import { useVersionVerdict, VersionGate } from "../src/version-gate";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
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
  } as const;
}

/** A top section of the app: a large title, and the menu button where a back button would be. */
const section = (title: string) =>
  ({
    title,
    headerLargeTitle: true,
    headerLeft: () => <MenuButton />,
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
  const header = useHeaderOptions();
  const drawer = useDrawer();
  const pathname = usePathname();
  const backdrop = useCSSVariable("--color-backdrop") as string | undefined;
  // The menu swipes in only on a section's own screen: deeper in, the same swipe is the way back.
  const atSection = SECTIONS.some((item) => item.href === pathname);
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
          <Stack.Protected guard={signedIn}>
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
                sheetAllowedDetents: [0.6, 1],
                sheetGrabberVisible: true,
              }}
            />
            <Stack.Screen
              name="new-conversation"
              options={{
                title: "New conversation",
                presentation: "formSheet",
                sheetAllowedDetents: [0.6, 1],
                sheetGrabberVisible: true,
              }}
            />
            <Stack.Screen
              name="new-bot"
              options={{
                title: "New Bot",
                presentation: "formSheet",
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
          <Stack.Protected guard={!signedIn}>
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
  if (!fontsLoaded && !fontError) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <HeroUINativeProvider
          config={{ devInfo: { stylingPrinciples: false } }}
        >
          <DrawerProvider>
            <SecuredLayout />
          </DrawerProvider>
        </HeroUINativeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
