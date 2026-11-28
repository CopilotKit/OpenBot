/**
 * Runs the pure machine (src/logic/machine.ts) in the app: holds its state, turns platform callbacks
 * into its events, and performs the effects it asks for (timers, the sign-in sheet, cookie checks,
 * scripts for the page). The only place with side effects.
 */
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import * as WebBrowser from "expo-web-browser";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Keyboard,
  Linking,
  Platform,
  Share,
} from "react-native";
import type WebView from "react-native-webview";
import ShellNative from "../../modules/shell-native/src";
import { BASE_HOST, BASE_URL, hooks, PLATFORM } from "../config";
import { decideHandoff, redirectUrlFor } from "../logic/handoffConfig";
import {
  type Config,
  type Effect,
  type Event,
  initialState,
  reduce,
  type State,
  type TimerName,
} from "../logic/machine";
import { makePkcePair } from "../logic/pkce";
import { BLUR_SCRIPT } from "../logic/injected";
import { redact } from "../logic/urls";

export const shellConfig: Config = {
  origin: BASE_URL,
  platform: PLATFORM,
  handoffAuto: hooks.handoffAuto,
};

/** Log lines only in a test build (and only redacted: paths and parameter names, never values). */
export function diag(event: string, fields?: Record<string, unknown>) {
  // Inline so a store bundle drops the whole body (and the prefix) at build time.
  if (process.env.EXPO_PUBLIC_OPENBOT_TEST_BUILD !== "1" || !hooks.diagnostics)
    return;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    safe[key] =
      typeof value === "string" && /^[a-z][a-z0-9+.-]*:/i.test(value)
        ? redact(value)
        : value;
  }
  console.log(
    `OPENBOT_DIAG ${JSON.stringify({ event, at: Date.now(), ...safe })}`,
  );
}

async function pkcePair() {
  return makePkcePair(
    (count) => Crypto.getRandomBytes(count),
    async (text) =>
      new Uint8Array(
        await Crypto.digest(
          Crypto.CryptoDigestAlgorithm.SHA256,
          new TextEncoder().encode(text),
        ),
      ),
  );
}

/** `GET /api/auth/shell/config?platform=` without cookies, 15 s at most. */
async function fetchConfig(): Promise<{
  status: number | null;
  body: string | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `${BASE_URL}/api/auth/shell/config?platform=${PLATFORM}`,
      {
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    return { status: null, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

export function useShell(webRef: RefObject<WebView | null>) {
  const stateRef = useRef<State>(initialState());
  const [state, setState] = useState<State>(stateRef.current);
  const timers = useRef(new Map<TimerName, ReturnType<typeof setTimeout>>());
  const dispatchRef = useRef<(event: Event) => void>(() => undefined);

  const run = useCallback(
    (effect: Effect) => {
      const dispatch = dispatchRef.current;
      switch (effect.type) {
        case "log":
          diag(effect.event, effect.fields);
          return;
        case "timer": {
          const existing = timers.current.get(effect.name);
          if (existing) clearTimeout(existing);
          timers.current.set(
            effect.name,
            setTimeout(() => {
              timers.current.delete(effect.name);
              dispatch({ type: "timer", name: effect.name });
            }, effect.ms),
          );
          return;
        }
        case "cancelTimer": {
          const existing = timers.current.get(effect.name);
          if (existing) clearTimeout(existing);
          timers.current.delete(effect.name);
          return;
        }
        case "fetchConfig": {
          void (async () => {
            const [answer, pair] = await Promise.all([
              fetchConfig(),
              pkcePair(),
            ]);
            let httpsSupported = false;
            try {
              httpsSupported = ShellNative.httpsCallbackSupported(BASE_HOST);
            } catch {
              httpsSupported = false;
            }
            const mode = decideHandoff(
              answer.status,
              answer.body,
              BASE_HOST,
              httpsSupported,
            );
            if (effect.purpose === "sign-in")
              dispatch({ type: "configAnswered", mode, pair });
            else
              dispatch({
                type: "renewalConfigAnswered",
                mode,
                pair,
                to: effect.to,
                intercepted: effect.intercepted,
              });
          })();
          return;
        }
        case "openSheet": {
          const redirect = redirectUrlFor(effect.mode);
          if (Platform.OS === "ios") {
            // ASWebAuthenticationSession, NOT ephemeral: the sheet shares Safari's sign-ins (Google's
            // included). The callback scheme is not registered by the app: only this sheet takes it.
            WebBrowser.openAuthSessionAsync(effect.url, redirect, {
              preferEphemeralSession: false,
              preferUniversalLinks: effect.mode.kind === "https",
            })
              .then((result) =>
                dispatch({
                  type: "sheetResult",
                  result: result.type === "success" ? "success" : "cancel",
                  url: result.type === "success" ? result.url : null,
                }),
              )
              .catch(() => dispatch({ type: "sheetFailedToOpen" }));
          } else {
            // A Chrome Custom Tab in its own task; the ticket comes back as an intent (Linking).
            WebBrowser.openBrowserAsync(effect.url, {
              createTask: true,
              showInRecents: false,
            })
              .then((result) => {
                if (result.type !== "opened")
                  dispatch({ type: "sheetFailedToOpen" });
              })
              .catch(() => dispatch({ type: "sheetFailedToOpen" }));
          }
          return;
        }
        case "closeSheet":
          if (Platform.OS === "ios") {
            try {
              WebBrowser.dismissAuthSession();
            } catch {
              // Already closed.
            }
          }
          return;
        case "checkSession":
          ShellNative.hasSessionCookie(BASE_URL)
            .then((present) =>
              dispatch({
                type: "sessionChecked",
                reason: effect.reason,
                present,
              }),
            )
            .catch(() =>
              dispatch({
                type: "sessionChecked",
                reason: effect.reason,
                present: false,
              }),
            );
          return;
        case "clearSiteData":
          ShellNative.clearSiteData(BASE_URL)
            .then((count) => diag("site-data-cleared", { cookies: count }))
            .catch(() => diag("site-data-clear-failed"))
            .finally(() => {
              if (effect.andThen === "continue")
                dispatch({ type: "siteDataCleared" });
            });
          return;
        case "flushCookies":
          try {
            ShellNative.flushCookies();
          } catch {
            // Nothing to flush.
          }
          return;
        case "dismissKeyboard":
          webRef.current?.injectJavaScript(BLUR_SCRIPT);
          try {
            ShellNative.dismissKeyboard();
          } catch {
            Keyboard.dismiss();
          }
          return;
        case "inject":
          webRef.current?.injectJavaScript(effect.script);
          return;
        case "openExternal":
          void Linking.openURL(effect.url).catch(() =>
            diag("open-external-failed"),
          );
          return;
        case "openBrowser":
          void WebBrowser.openBrowserAsync(effect.url).catch(() =>
            diag("open-browser-failed"),
          );
          return;
        case "ping":
          void fetchConfig().then((answer) =>
            dispatch({ type: "pingAnswered", ok: answer.status !== null }),
          );
          return;
        case "share":
          void Share.share(
            Platform.OS === "ios"
              ? { url: effect.url }
              : { message: effect.url },
          ).catch(() => undefined);
          return;
        case "alert":
          Alert.alert("OpenBot", effect.message);
          return;
      }
    },
    [webRef],
  );

  const dispatch = useCallback(
    (event: Event) => {
      const step = reduce(shellConfig, stateRef.current, event, Date.now());
      stateRef.current = step.state;
      setState(step.state);
      for (const effect of step.effects) run(effect);
    },
    [run],
  );
  dispatchRef.current = dispatch;

  // Launch: the test hooks prepare the cookie store, then the session cookie decides.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (hooks.reset) await ShellNative.clearAllData();
        if (hooks.sessionCookie)
          await ShellNative.setCookie(
            BASE_URL,
            "__Secure-better-auth.session_token",
            hooks.sessionCookie,
            true,
          );
        if (hooks.plainSessionCookie)
          await ShellNative.setCookie(
            BASE_URL,
            "better-auth.session_token",
            hooks.plainSessionCookie,
            false,
          );
        if (hooks.staleSession)
          await ShellNative.setCookie(
            BASE_URL,
            "better-auth.session_token",
            "stale",
            false,
          );
      } catch {
        diag("test-hook-failed");
      }
      let hasSession = false;
      try {
        hasSession = await ShellNative.hasSessionCookie(BASE_URL);
      } catch {
        hasSession = false;
      }
      if (alive)
        dispatch({ type: "launch", hasSession, probeUrl: hooks.probeUrl });
    })();
    return () => {
      alive = false;
    };
  }, [dispatch]);

  // The network: offline only when there is no connection at all (a network Android has not
  // validated still reaches a VPC-only OpenBot).
  useEffect(() => {
    if (hooks.forceOffline) {
      dispatch({ type: "network", offline: true });
      return;
    }
    let forced = hooks.forceOfflineSeconds > 0;
    let last = false;
    if (forced) dispatch({ type: "network", offline: true });
    const release = forced
      ? setTimeout(() => {
          forced = false;
          dispatch({ type: "network", offline: last });
        }, hooks.forceOfflineSeconds * 1000)
      : null;
    const apply = (networkState: Network.NetworkState) => {
      last = networkState.isConnected === false;
      if (!forced) dispatch({ type: "network", offline: last });
    };
    void Network.getNetworkStateAsync()
      .then(apply)
      .catch(() => undefined);
    const subscription = Network.addNetworkStateListener(apply);
    return () => {
      subscription.remove();
      if (release) clearTimeout(release);
    };
  }, [dispatch]);

  // Foreground and background.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") dispatch({ type: "appState", active: true });
      else if (next === "background")
        dispatch({ type: "appState", active: false });
    });
    return () => subscription.remove();
  }, [dispatch]);

  // Android: the sign-in's callback arrives as an intent. iOS registers no scheme (the sheet takes it).
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = Linking.addEventListener("url", ({ url }) =>
      dispatch({ type: "callbackUrl", url }),
    );
    return () => subscription.remove();
  }, [dispatch]);

  // Android's callback trampoline forwards a callback only while a sign-in is pending.
  const pending = state.pending !== null;
  useEffect(() => {
    try {
      ShellNative.setSignInPending(pending);
    } catch {
      // Not there (iOS registers no scheme).
    }
  }, [pending]);

  useEffect(
    () => () => {
      for (const handle of timers.current.values()) clearTimeout(handle);
      timers.current.clear();
    },
    [],
  );

  return { state, stateRef, dispatch };
}
