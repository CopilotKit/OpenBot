/**
 * OpenBot Mobile as the web app in a web view, with the phone's own parts kept native.
 *
 * The web app (./configured.ts) draws every screen, and its page holds the sign-in. What a page can't do, or does
 * badly, the app does:
 *
 * - the launch: the phone's splash and the cover over it (../launch.tsx) stay until the page has drawn;
 * - push notifications: asking the person, the push token, and opening the page a notification is about
 *   (./push.ts, ./navigation.ts). The page tells OpenBot which phone it is (./bridge.ts);
 * - the way out of the page: a link to another app or another site opens there, Android's back button goes
 *   back a page, and a page that pays for a plan is never opened (./navigation.ts);
 * - a page that can't be reached: one sentence and a way to try again, in the app's own words;
 * - the security floor (../floor-gate.tsx), which the root layout draws over this as it does over the screens.
 */
import * as Notifications from "expo-notifications";
import { Button } from "heroui-native/button";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  Linking,
  Platform,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type {
  ShouldStartLoadRequest,
  WebViewMessageEvent,
} from "react-native-webview/lib/WebViewTypes";
import { useCSSVariable } from "uniwind";
import { Text } from "../components";
import { useLaunchExpectsOrb, useLaunchSettled } from "../launch";
import { clientHeaders, RELEASE } from "../release";
import {
  bridgeScript,
  holdCall,
  PROBE,
  readPageMessage,
  registerCall,
} from "./bridge";
import { navigationVerdict, webDestination } from "./navigation";
import { phoneForPush } from "./push";

export const UNREACHABLE_HEADING = "Couldn't reach OpenBot";
export const UNREACHABLE_LINE =
  "Check your connection, then try again in a moment.";
/** Said when a page asks for a payment page. It names no other place to pay: the stores don't allow that. */
export const NOT_IN_THE_APP_HEADING = "Not available in the app";
export const NOT_IN_THE_APP_LINE = "Your plan can't be changed here.";

/** The address a page's message came from, or null for one that is not an address. */
function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/** Send the page to an address, as a tap on a link would. */
const goTo = (address: string) =>
  `location.href=${JSON.stringify(address)};true;`;

export function WebShell({ address }: { address: string }) {
  // The package types its own properties away unless it is told there are no others: `object` says so.
  const web = useRef<WebView<object>>(null);
  const insets = useSafeAreaInsets();
  const background = useCSSVariable("--color-background") as string | undefined;
  const accent = useCSSVariable("--color-accent") as string | undefined;

  // A notification that started the app says where it opens. Read once, so a later draw doesn't open it again.
  const handled = useRef<string | null>(null);
  const [start] = useState(() => {
    const last = Notifications.getLastNotificationResponse();
    if (!last) return `${address}/`;
    handled.current = last.notification.request.identifier;
    return (
      webDestination(address, last.notification.request.content.data) ??
      `${address}/`
    );
  });
  // A page that failed is loaded again in a new web view: a reload of a failed first load has nothing to reload.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [progress, setProgress] = useState(1);
  const canGoBack = useRef(false);

  // The launch cover waits for the page as it waits for the session on the app's own screens. The page checks
  // its own version against its server, so the app's version check has nothing to wait for.
  useLaunchSettled("session", drawn || failed);
  useLaunchSettled("version", true);
  useLaunchExpectsOrb(false);

  // Who the phone is registered for, while the app runs: once for each person, and never for nobody.
  const registeredFor = useRef<string | null>(null);
  const phone = useRef<string | null>(null);
  const onSession = useCallback(async (person: string | undefined) => {
    if (!person) {
      registeredFor.current = null;
      return;
    }
    if (registeredFor.current === person) {
      // A new page since: it has to be told again which phone to take off at sign-out.
      if (phone.current) web.current?.injectJavaScript(holdCall(phone.current));
      return;
    }
    registeredFor.current = person;
    const found = await phoneForPush().catch(() => null);
    // Somebody else signed in while the person was asked.
    if (!found || registeredFor.current !== person) return;
    phone.current = found.id;
    web.current?.injectJavaScript(registerCall(found));
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      // Only the web app's own page is listened to: the sign-in's pages, and any other, can't speak for it.
      if (originOf(event.nativeEvent.url) !== address) return;
      const message = readPageMessage(event.nativeEvent.data);
      if (message?.type === "session")
        void onSession(message.signedIn ? message.person : undefined);
    },
    [address, onSession],
  );

  const decide = useCallback(
    (request: ShouldStartLoadRequest) => {
      const verdict = navigationVerdict(request.url, address);
      if (verdict === "load") return true;
      if (verdict === "outside")
        void Linking.openURL(request.url).catch(() => {});
      if (verdict === "purchase")
        Alert.alert(NOT_IN_THE_APP_HEADING, NOT_IN_THE_APP_LINE);
      return false;
    },
    [address],
  );

  // A link the page opens in a new window is another site: the phone's browser opens it, and the page stays.
  const openOutside = useCallback(
    (target: string) => {
      const verdict = navigationVerdict(target, address);
      if (verdict === "purchase")
        Alert.alert(NOT_IN_THE_APP_HEADING, NOT_IN_THE_APP_LINE);
      else if (verdict !== "blocked")
        void Linking.openURL(target).catch(() => {});
    },
    [address],
  );

  // A tap on a notification, while the app runs, opens the page it is about.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const id = response.notification.request.identifier;
        if (handled.current === id) return;
        handled.current = id;
        const to = webDestination(
          address,
          response.notification.request.content.data,
        );
        if (to) web.current?.injectJavaScript(goTo(to));
      },
    );
    return () => subscription.remove();
  }, [address]);

  // Back in front: the sign-in may have ended while the app was away.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") web.current?.injectJavaScript(PROBE);
    });
    return () => subscription.remove();
  }, []);

  // Android's back button goes back a page, and leaves the app from the first one.
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (!canGoBack.current) return false;
        web.current?.goBack();
        return true;
      },
    );
    return () => subscription.remove();
  }, []);

  const again = useCallback(() => {
    setFailed(false);
    setProgress(0);
    setAttempt((count) => count + 1);
  }, []);

  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {/* Android resizes nothing for the keyboard under the app's keyboard provider, so the page is moved up. */}
      <KeyboardAvoidingView
        behavior="padding"
        enabled={Platform.OS === "android"}
        style={{ flex: 1 }}
      >
        <WebView<object>
          key={attempt}
          ref={web}
          source={{ uri: start }}
          style={{ flex: 1, backgroundColor: background ?? "transparent" }}
          containerStyle={{ backgroundColor: background ?? "transparent" }}
          // Says which app this is, after the phone's own browser name: `OpenBotMobile/<release>`.
          applicationNameForUserAgent={`OpenBotMobile/${RELEASE ?? "0"}`}
          injectedJavaScriptBeforeContentLoaded={bridgeScript({
            origin: address,
            client: clientHeaders()["OpenBot-Client"],
          })}
          onMessage={onMessage}
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={decide}
          setSupportMultipleWindows={false}
          onOpenWindow={(event) => openOutside(event.nativeEvent.targetUrl)}
          // The sign-in is the page's: its cookies are kept between starts, as a browser keeps them.
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          domStorageEnabled
          // The page asks for the microphone to dictate. The phone asks the person once, for the app.
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          allowsInlineMediaPlayback
          allowsBackForwardNavigationGestures
          allowsLinkPreview={false}
          bounces={false}
          overScrollMode="never"
          decelerationRate="normal"
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          textZoom={100}
          webviewDebuggingEnabled={__DEV__}
          onNavigationStateChange={(state) => {
            canGoBack.current = state.canGoBack;
          }}
          onLoadProgress={(event) =>
            setProgress(Math.round(event.nativeEvent.progress * 20) / 20)
          }
          onLoadEnd={() => {
            setDrawn(true);
            setProgress(1);
          }}
          onError={() => setFailed(true)}
          onHttpError={(event) => {
            // The web app's own address answering that it is down. Any other page's failure is that page's.
            if (
              event.nativeEvent.statusCode >= 500 &&
              originOf(event.nativeEvent.url) === address
            )
              setFailed(true);
          }}
          // The phone took the page's memory back while the app was away: the page is loaded again.
          onContentProcessDidTerminate={() => web.current?.reload()}
          onRenderProcessGone={again}
          // The app draws its own notice below. Without these the web view draws a browser's.
          renderError={() => <View className="flex-1 bg-background" />}
          renderLoading={() => <View className="flex-1 bg-background" />}
        />
        {progress < 1 && !failed && (
          <View
            pointerEvents="none"
            className="absolute left-0 right-0 top-0 h-0.5"
          >
            <View
              style={{
                width: `${Math.max(8, Math.round(progress * 100))}%`,
                height: "100%",
                backgroundColor: accent,
              }}
            />
          </View>
        )}
      </KeyboardAvoidingView>
      {failed && (
        <View
          className="absolute inset-0 items-center justify-center bg-background px-6"
          accessibilityViewIsModal
        >
          <View className="w-full max-w-[480px] gap-3">
            <Text variant="title">{UNREACHABLE_HEADING}</Text>
            <Text>{UNREACHABLE_LINE}</Text>
            <View className="mt-2 min-h-10 items-start justify-center">
              <Button onPress={again}>Try again</Button>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
