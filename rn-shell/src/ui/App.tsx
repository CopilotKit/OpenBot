import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import WebView from "react-native-webview";
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewNavigationEvent,
  WebViewOpenWindowEvent,
} from "react-native-webview/lib/WebViewTypes";
import { BASE_URL, hooks, PLATFORM, USER_AGENT_MARK, VERSION } from "../config";
import { parsePageMessage } from "../logic/bridge";
import { injectedScript } from "../logic/injected";
import {
  debugState,
  decideNavigation,
  lockReason,
  showsLock,
  showsSignInScreen,
  showsSkeleton,
  showsTabBar,
  showsWebSignInBar,
  signInBusy,
  webMounted,
} from "../logic/machine";
import { FirstScreen } from "./FirstScreen";
import { LockScreen } from "./LockScreen";
import { Skeleton } from "./Skeleton";
import { TabBar } from "./TabBar";
import { colorsFor, useColors } from "./theme";
import { diag, shellConfig, useShell } from "./useShell";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** This launch's bridge token: only the script in the main frame of the app's own origin knows it. */
function makeToken(): string {
  // expo-crypto's random UUID is a CSPRNG; two of them make 244 random bits.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Crypto = require("expo-crypto") as typeof import("expo-crypto");
  return (Crypto.randomUUID() + Crypto.randomUUID()).replace(/-/g, "");
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const webRef = useRef<WebView>(null);
  const { state, stateRef, dispatch } = useShell(webRef);
  const systemColors = useColors();
  const insets = useSafeAreaInsets();
  const token = useMemo(makeToken, []);
  const startScript = useMemo(
    () =>
      injectedScript({
        origin: BASE_URL,
        platform: PLATFORM,
        version: VERSION,
        token,
        when: "start",
      }),
    [token],
  );
  const endScript = useMemo(
    () =>
      injectedScript({
        origin: BASE_URL,
        platform: PLATFORM,
        version: VERSION,
        token,
        when: "end",
      }),
    [token],
  );
  const [rootHeight, setRootHeight] = useState(0);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [released, setReleased] = useState(hooks.delayFirstLoadMs <= 0);

  useEffect(() => {
    if (released) return;
    const handle = setTimeout(() => setReleased(true), hooks.delayFirstLoadMs);
    return () => clearTimeout(handle);
  }, [released]);

  // The keyboard: the web view ends at its top edge, and the tab bar hides while it is up.
  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      // keyboardWillChangeFrame also fires on the way down, with the keyboard below the screen.
      const screenHeight = Dimensions.get("screen").height;
      if (
        event.endCoordinates.height <= 0 ||
        event.endCoordinates.screenY >= screenHeight - 1
      ) {
        setKeyboardTop(null);
        dispatch({ type: "keyboard", visible: false });
        return;
      }
      setKeyboardTop(event.endCoordinates.screenY);
      dispatch({ type: "keyboard", visible: true });
    };
    const hide = () => {
      setKeyboardTop(null);
      dispatch({ type: "keyboard", visible: false });
    };
    const subscriptions =
      Platform.OS === "ios"
        ? [
            Keyboard.addListener("keyboardWillShow", show),
            Keyboard.addListener("keyboardWillChangeFrame", show),
            Keyboard.addListener("keyboardWillHide", hide),
          ]
        : [
            Keyboard.addListener("keyboardDidShow", show),
            Keyboard.addListener("keyboardDidHide", hide),
          ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [dispatch]);

  // Android Back: back in the web view while there is somewhere in the app to go, else the system's.
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        const s = stateRef.current;
        if (showsLock(s)) return false;
        if (s.phase === "signedOut" && s.signIn === "webFallback") {
          if (s.canGoBack) webRef.current?.goBack();
          else dispatch({ type: "cancelWebSignIn" });
          return true;
        }
        if (s.phase === "signedIn" && s.canGoBack) {
          webRef.current?.goBack();
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [dispatch, stateRef]);

  const onShouldStart = useCallback(
    (request: ShouldStartLoadRequest) => {
      const extra = request as ShouldStartLoadRequest & {
        hasGesture?: boolean;
        isTopFrame?: boolean;
      };
      const decision = decideNavigation(
        shellConfig,
        stateRef.current,
        {
          url: request.url,
          isTopFrame: extra.isTopFrame,
          navigationType: request.navigationType,
          hasGesture: extra.hasGesture,
        },
        Date.now(),
      );
      if (decision.events.length > 0)
        setTimeout(() => decision.events.forEach(dispatch), 0);
      return decision.allow;
    },
    [dispatch, stateRef],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parsePageMessage(
        event.nativeEvent.data,
        event.nativeEvent.url,
        BASE_URL,
        token,
      );
      if (!message) {
        diag("bridge-rejected", { url: event.nativeEvent.url });
        return;
      }
      if (message.kind === "bridge")
        diag("bridge", {
          type: message.message.type,
          ...("path" in message.message
            ? {
                path: message.message.path,
                tab: message.message.tab,
                signedIn: message.message.signedIn,
              }
            : {}),
        });
      dispatch({ type: "page", message });
    },
    [dispatch, token],
  );

  const pageColors =
    state.pageDark === null ? systemColors : colorsFor(state.pageDark);
  const onWeb = !showsSignInScreen(state) && !showsLock(state);
  const chromeBackground = onWeb
    ? (state.pageColor ?? pageColors.background)
    : systemColors.background;
  const chromeDark = onWeb ? pageColors.dark : systemColors.dark;
  const keyboardOverlap =
    keyboardTop !== null && rootHeight > 0
      ? Math.max(0, rootHeight - keyboardTop)
      : 0;
  const tabBar = showsTabBar(state);
  const bottomPadding =
    keyboardOverlap > 0 ? keyboardOverlap : tabBar ? 0 : insets.bottom;
  const mounted = webMounted(state) && released;

  return (
    <View
      style={[styles.root, { backgroundColor: chromeBackground }]}
      onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}
    >
      <StatusBar style={chromeDark ? "light" : "dark"} />
      <View
        style={[
          styles.column,
          { paddingTop: insets.top, paddingBottom: bottomPadding },
        ]}
      >
        {showsWebSignInBar(state) ? (
          <View
            style={[
              styles.cancelBar,
              { borderBottomColor: systemColors.border },
            ]}
          >
            <Pressable
              testID="web-sign-in-cancel"
              accessibilityRole="button"
              onPress={() => dispatch({ type: "cancelWebSignIn" })}
              hitSlop={8}
            >
              <Text
                style={[styles.cancelText, { color: systemColors.foreground }]}
              >
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.webArea}>
          {mounted && state.source ? (
            <WebView
              key={state.webKey}
              ref={webRef}
              testID="openbot-webview"
              source={state.source}
              // Every navigation is decided in onShouldStartLoadWithRequest. A narrower list would make
              // react-native-webview hand whatever it does not match to Linking.openURL by itself.
              originWhitelist={["*"]}
              onShouldStartLoadWithRequest={onShouldStart}
              injectedJavaScriptBeforeContentLoaded={startScript}
              // iOS: into every frame, where other origins' dialogs are switched off. The script itself
              // installs the marker and the bridge only in the main frame of the app's own origin.
              injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
              injectedJavaScript={endScript}
              injectedJavaScriptForMainFrameOnly
              onMessage={onMessage}
              applicationNameForUserAgent={USER_AGENT_MARK}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              allowsLinkPreview={false}
              mixedContentMode="never"
              setSupportMultipleWindows
              javaScriptCanOpenWindowsAutomatically={false}
              onOpenWindow={(event: WebViewOpenWindowEvent) =>
                dispatch({
                  type: "openWindow",
                  url: event.nativeEvent.targetUrl,
                })
              }
              onFileDownload={(event) =>
                dispatch({
                  type: "fileDownload",
                  url: event.nativeEvent.downloadUrl,
                })
              }
              onContentProcessDidTerminate={() =>
                dispatch({ type: "processGone" })
              }
              onRenderProcessGone={() => dispatch({ type: "processGone" })}
              onLoad={(event: WebViewNavigationEvent) =>
                dispatch({ type: "loadEnd", url: event.nativeEvent.url })
              }
              onError={(event: WebViewErrorEvent) =>
                dispatch({
                  type: "loadError",
                  url: event.nativeEvent.url ?? null,
                  code: event.nativeEvent.code,
                  description: event.nativeEvent.description,
                })
              }
              onHttpError={(event: WebViewHttpErrorEvent) =>
                dispatch({
                  type: "httpError",
                  url: event.nativeEvent.url,
                  status: event.nativeEvent.statusCode,
                })
              }
              onNavigationStateChange={(navigation: WebViewNavigation) =>
                dispatch({
                  type: "urlChanged",
                  url: navigation.url,
                  canGoBack: navigation.canGoBack,
                })
              }
              renderError={() => (
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: chromeBackground },
                  ]}
                />
              )}
              hideKeyboardAccessoryView
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              allowsBackForwardNavigationGestures
              // Inline (not the imported TEST_BUILD) so a store bundle folds it away with what it guards.
              webviewDebuggingEnabled={
                process.env.EXPO_PUBLIC_OPENBOT_TEST_BUILD === "1"
              }
              mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
              geolocationEnabled={false}
              pullToRefreshEnabled={false}
              androidLayerType={hooks.softwareLayer ? "software" : "none"}
              style={{ backgroundColor: chromeBackground }}
              containerStyle={{ backgroundColor: chromeBackground }}
            />
          ) : null}
          {showsSkeleton(state) ? (
            <Skeleton colors={pageColors} background={chromeBackground} />
          ) : null}
        </View>
        {tabBar ? (
          <TabBar
            colors={pageColors}
            selected={state.tab}
            background={chromeBackground}
            bottomInset={insets.bottom}
            disabled={state.signIn === "entering"}
            onPress={(tab) => dispatch({ type: "tabPressed", tab })}
          />
        ) : null}
      </View>
      {showsSignInScreen(state) ? (
        <FirstScreen
          colors={systemColors}
          launching={state.phase === "launching"}
          busy={signInBusy(state)}
          message={state.message}
          onSignIn={() => dispatch({ type: "signInPressed" })}
          onLayout={() => void SplashScreen.hideAsync().catch(() => undefined)}
        />
      ) : null}
      {showsLock(state) ? (
        <LockScreen
          colors={systemColors}
          reason={lockReason(state)}
          onRetry={() => dispatch({ type: "retry", automatic: false })}
        />
      ) : null}
      {process.env.EXPO_PUBLIC_OPENBOT_TEST_BUILD === "1" ? (
        <Text
          pointerEvents="none"
          testID="debug-state"
          accessibilityLabel={`debug-state ${debugState(state, BASE_URL)}`}
          style={styles.debug}
        >
          {`debug-state ${debugState(state, BASE_URL)}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  column: { flex: 1 },
  webArea: { flex: 1, overflow: "hidden" },
  cancelBar: {
    height: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cancelText: { fontSize: 17 },
  // A label for the UI tests (test builds only): on screen as far as the accessibility tree is
  // concerned (UiAutomator drops nearly transparent views), invisible to a person.
  debug: {
    position: "absolute",
    left: 0,
    top: "50%",
    width: 3,
    height: 3,
    fontSize: 2,
    color: "transparent",
  },
});
