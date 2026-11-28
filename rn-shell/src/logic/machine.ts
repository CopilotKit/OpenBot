/**
 * The whole app's behaviour as one pure reducer: `reduce(config, state, event)` answers the next
 * state and the effects to run (timers, the sheet, cookie checks, scripts for the page). Nothing here
 * touches React Native, so every rule the two native shells learned is unit-tested on a laptop
 * (__tests__/machine.test.ts); `src/ui/useShell.ts` runs the effects and feeds events back.
 *
 * Phases: launching (deciding), signedOut (the native first screen, or a sign-in in progress:
 * probing the server, the system sheet, entering, or the web sign-in fallback), signedIn (the web
 * view with the tab bar). Over any of them: the lock screen (no network, or the web app did not
 * load) and, over the web view, the loading skeleton until the page has drawn text.
 */
import { callbackName, type HandoffMode, ticketFrom } from "./handoffConfig";
import type { PkcePair } from "./pkce";
import {
  enterUrl,
  handoffPath,
  isHostedSignIn,
  isOwnOrigin,
  isReloadableOwnUrl,
  isShellAuthUrl,
  isSignPath,
  pathOf,
  type Platform,
  renewalTo,
  renewalUrl,
  schemeOf,
} from "./urls";

export type Phase = "launching" | "signedOut" | "signedIn";
export type SignInStep =
  | "idle"
  | "probing"
  | "sheet"
  | "entering"
  | "webFallback";
export type Tab = "conversations" | "home" | "bots";
export const TABS: readonly Tab[] = ["conversations", "home", "bots"];
export const TAB_PATHS: Record<Tab, string> = {
  conversations: "/conversations",
  home: "/",
  bots: "/bots",
};

export type Config = {
  origin: string;
  platform: Platform;
  /** Test hook: `&auto=1` on the hand-off (the mock follows its link by itself). */
  handoffAuto: boolean;
};

export type WebSource = { uri: string; headers?: Record<string, string> };

export type TimerName =
  | "watchdog"
  | "enter"
  | "sheetClosed"
  | "noReady"
  | "textWait"
  | "readyText"
  | "hideSkeleton"
  | "skeletonDeadline"
  | "signConfirm"
  | "autoRetry";

export type SessionCheckReason =
  | "entering-url"
  | "web-fallback-url"
  | "enter-timeout"
  | "sign-confirm";

export type Effect =
  | { type: "fetchConfig"; purpose: "sign-in" }
  | { type: "fetchConfig"; purpose: "renewal"; to: string; intercepted: string }
  | { type: "openSheet"; url: string; mode: HandoffMode }
  | { type: "closeSheet" }
  | { type: "timer"; name: TimerName; ms: number }
  | { type: "cancelTimer"; name: TimerName }
  | { type: "checkSession"; reason: SessionCheckReason }
  | { type: "clearSiteData" }
  | { type: "flushCookies" }
  | { type: "dismissKeyboard" }
  | { type: "inject"; script: string }
  | { type: "openExternal"; url: string }
  | { type: "openBrowser"; url: string }
  | { type: "ping" }
  | { type: "share"; url: string }
  | { type: "alert"; message: string }
  | { type: "log"; event: string; fields?: Record<string, unknown> };

/** What the page's injected script reports (already checked: main frame, own origin, token). */
export type PageMessage =
  | { kind: "doc"; late: boolean }
  | { kind: "text"; body: number; main: number }
  | { kind: "tap" }
  | { kind: "chrome"; color: string; dark: boolean }
  | { kind: "alert"; message: string }
  | { kind: "open"; handled: boolean }
  | {
      kind: "bridge";
      message:
        | { type: "ready" }
        | { type: "signed-out" }
        | { type: "route"; path: string; tab: Tab | null; signedIn: boolean };
    };

export type Event =
  | { type: "launch"; hasSession: boolean; probeUrl?: string | null }
  | { type: "signInPressed" }
  | { type: "configAnswered"; mode: HandoffMode; pair: PkcePair }
  | {
      type: "renewalConfigAnswered";
      mode: HandoffMode;
      pair: PkcePair;
      to: string;
      intercepted: string;
    }
  | { type: "sheetFailedToOpen" }
  | { type: "sheetResult"; result: "success" | "cancel"; url: string | null }
  | { type: "callbackUrl"; url: string }
  | { type: "cancelWebSignIn" }
  | { type: "page"; message: PageMessage }
  | { type: "navStart"; url: string }
  | { type: "loadEnd"; url: string }
  | { type: "loadError"; url: string | null; code: number; description: string }
  | { type: "httpError"; url: string; status: number }
  | { type: "urlChanged"; url: string; canGoBack: boolean }
  | { type: "sessionChecked"; reason: SessionCheckReason; present: boolean }
  | { type: "timer"; name: TimerName }
  | { type: "network"; offline: boolean }
  | { type: "retry"; automatic: boolean }
  | { type: "pingAnswered"; ok: boolean }
  | { type: "tabPressed"; tab: Tab }
  | { type: "keyboard"; visible: boolean }
  | { type: "processGone" }
  | { type: "appState"; active: boolean }
  | { type: "interceptRenewal"; url: string }
  | { type: "allowedOnce" }
  | { type: "openWindow"; url: string }
  | { type: "fileDownload"; url: string }
  | { type: "openBrowser"; url: string }
  | { type: "openExternal"; url: string }
  | { type: "blocked"; reason: string; url: string };

export type Pending = {
  pair: PkcePair;
  mode: HandoffMode;
  to: string;
  renewal: boolean;
};

export type State = {
  phase: Phase;
  signIn: SignInStep;
  message: string | null;
  offline: boolean;
  loadFailed: boolean;
  failureSource: "web" | "signIn" | null;
  retryCount: number;
  tab: Tab;
  keyboard: boolean;
  /** Bumped to throw the web view away and make a new one (fresh history, a dead process, a reload). */
  webKey: number;
  source: WebSource | null;
  /** The last page of the app's own origin, never /sign or /api/: what a retry or a restart loads. */
  lastOwnUrl: string | null;
  currentUrl: string | null;
  /** The main-frame navigation in flight (to tell whose failure a load error is). */
  pendingNavUrl: string | null;
  canGoBack: boolean;
  /** The skeleton covers the web view (it is shown only while the web view is). */
  pageLoading: boolean;
  loadingSince: number;
  hideScheduled: boolean;
  pageReady: boolean;
  bridgeSeen: boolean;
  committed: boolean;
  finished: boolean;
  textBody: number;
  textMain: number;
  noReadyPassed: boolean;
  readyTextPassed: boolean;
  commits: number;
  pending: Pending | null;
  handoffMode: HandoffMode | null;
  renewing: boolean;
  allowHostedOnce: string | null;
  lastTapAt: number;
  lastNavigation: "none" | "event" | "load";
  callbackArrived: boolean;
  /** The page's background colour (#rrggbb) and whether it draws dark: the strips around the web view follow it. */
  pageColor: string | null;
  pageDark: boolean | null;
};

export const MESSAGES = {
  notFinished: "Sign-in didn't finish. Try again.",
  tooLong: "Sign-in took too long. Try again.",
} as const;

export const TIMING = {
  watchdogMs: 20_000,
  enterMs: 30_000,
  sheetClosedMs: 600,
  noReadyMs: 1_500,
  textWaitMs: 8_000,
  readyTextMs: 3_000,
  minSkeletonMs: 300,
  afterReadyMs: 150,
  offOriginMs: 300,
  skeletonAfterCommitMs: 10_000,
  signConfirmMs: 2_500,
  retryMs: 5_000,
  slowRetryMs: 15_000,
  tapWindowMs: 1_500,
  readyTextChars: 20,
} as const;

export function initialState(): State {
  return {
    phase: "launching",
    signIn: "idle",
    message: null,
    offline: false,
    loadFailed: false,
    failureSource: null,
    retryCount: 0,
    tab: "home",
    keyboard: false,
    webKey: 0,
    source: null,
    lastOwnUrl: null,
    currentUrl: null,
    pendingNavUrl: null,
    canGoBack: false,
    pageLoading: false,
    loadingSince: 0,
    hideScheduled: false,
    pageReady: false,
    bridgeSeen: false,
    committed: false,
    finished: false,
    textBody: 0,
    textMain: 0,
    noReadyPassed: false,
    readyTextPassed: false,
    commits: 0,
    pending: null,
    handoffMode: null,
    renewing: false,
    allowHostedOnce: null,
    lastTapAt: -1e12,
    lastNavigation: "none",
    callbackArrived: false,
    pageColor: null,
    pageDark: null,
  };
}

// What is on screen, derived. ---------------------------------------------------------------------

export function showsSignInScreen(s: State): boolean {
  return (
    s.phase === "launching" ||
    (s.phase === "signedOut" &&
      s.signIn !== "webFallback" &&
      s.signIn !== "entering")
  );
}
export function webVisible(s: State): boolean {
  if (s.phase === "signedIn") return true;
  return (
    s.phase === "signedOut" &&
    (s.signIn === "webFallback" || s.signIn === "entering")
  );
}
/** The web view exists only while it is shown: each sign-in starts with a new one (fresh history). */
export function webMounted(s: State): boolean {
  return webVisible(s) && s.source !== null;
}
export function showsLock(s: State): boolean {
  return s.offline || s.loadFailed;
}
export function lockReason(s: State): "no-network" | "load-failed" | "none" {
  return s.offline ? "no-network" : s.loadFailed ? "load-failed" : "none";
}
export function showsSkeleton(s: State): boolean {
  return s.pageLoading && webVisible(s) && !showsLock(s);
}
export function showsTabBar(s: State): boolean {
  return s.phase === "signedIn" && !s.keyboard;
}
export function showsWebSignInBar(s: State): boolean {
  return s.phase === "signedOut" && s.signIn === "webFallback";
}
export function signInBusy(s: State): boolean {
  return (
    s.phase === "signedOut" && (s.signIn === "probing" || s.signIn === "sheet")
  );
}

/** One line for the tests (a hidden label in test builds). Never a URL's query, a ticket or a verifier. */
export function debugState(s: State, origin: string): string {
  const path = isOwnOrigin(s.currentUrl, origin)
    ? pathOf(s.currentUrl)
    : s.currentUrl
      ? "off-origin"
      : "-";
  const root = path.startsWith("/")
    ? `/${path.split("/").filter(Boolean)[0] ?? ""}`
    : path;
  return [
    `phase=${s.phase}`,
    `signIn=${s.signIn}`,
    `tab=${s.tab}`,
    `nav=${s.lastNavigation}`,
    `commits=${s.commits}`,
    `lock=${lockReason(s)}`,
    `keyboard=${s.keyboard ? 1 : 0}`,
    `path=${root}`,
    `skeleton=${showsSkeleton(s) ? 1 : 0}`,
    `bridge=${s.bridgeSeen ? 1 : 0}`,
    `ready=${s.pageReady ? 1 : 0}`,
  ].join(" ");
}

// The reducer. -------------------------------------------------------------------------------------

type Step = { state: State; effects: Effect[] };

export function reduce(
  config: Config,
  state: State,
  event: Event,
  at: number,
): Step {
  const step: Step = { state: { ...state }, effects: [] };
  handle(config, step, event, at);
  return step;
}

function set(step: Step, patch: Partial<State>) {
  step.state = { ...step.state, ...patch };
}
function fx(step: Step, ...effects: Effect[]) {
  step.effects.push(...effects);
}
function log(step: Step, event: string, fields?: Record<string, unknown>) {
  fx(step, { type: "log", event, fields });
}
function timer(step: Step, name: TimerName, ms: number) {
  fx(step, { type: "timer", name, ms });
}
function cancel(step: Step, ...names: TimerName[]) {
  for (const name of names) fx(step, { type: "cancelTimer", name });
}

function baseUrl(config: Config, path = "/"): string {
  return config.origin + path;
}

/** Retry and restart target: the last own page, never an address of the hand-off. */
function reloadTarget(config: Config, s: State): string {
  if (s.lastOwnUrl && isReloadableOwnUrl(s.lastOwnUrl, config.origin))
    return s.lastOwnUrl;
  return baseUrl(config);
}

function startCovering(step: Step, at: number) {
  const s = step.state;
  cancel(step, "hideSkeleton", "noReady", "textWait", "readyText");
  set(step, {
    pageLoading: true,
    loadingSince: s.pageLoading ? s.loadingSince : at,
    hideScheduled: false,
    pageReady: false,
    committed: false,
    finished: false,
    textBody: 0,
    textMain: 0,
    noReadyPassed: false,
    readyTextPassed: false,
  });
}

/** Loads `url` in the web view; the same address again needs a new web view to load at all. */
function load(
  config: Config,
  step: Step,
  url: string,
  at: number,
  headers?: Record<string, string>,
) {
  const s = step.state;
  const same = s.source?.uri === url;
  set(step, {
    source: headers ? { uri: url, headers } : { uri: url },
    webKey: same ? s.webKey + 1 : s.webKey,
    pendingNavUrl: url,
  });
  if (isReloadableOwnUrl(url, config.origin)) set(step, { lastOwnUrl: url });
  startCovering(step, at);
  timer(step, "watchdog", TIMING.watchdogMs);
  log(step, "load", {
    url: isShellAuthUrl(url, config.origin) ? "shell-auth" : url,
    header: headers !== undefined,
  });
}

/** A new web view at the last own page: after the process died, or for a retry. */
function remount(config: Config, step: Step, at: number) {
  const url = reloadTarget(config, step.state);
  set(step, {
    source: { uri: url },
    webKey: step.state.webKey + 1,
    pendingNavUrl: url,
    lastOwnUrl: url,
  });
  startCovering(step, at);
  timer(step, "watchdog", TIMING.watchdogMs);
}

function scheduleHide(step: Step, at: number, after: number) {
  const s = step.state;
  if (!s.pageLoading || s.hideScheduled) return;
  const delay = Math.max(
    after,
    TIMING.minSkeletonMs - (at - s.loadingSince),
    0,
  );
  set(step, { hideScheduled: true });
  cancel(step, "noReady", "textWait", "readyText");
  timer(step, "hideSkeleton", delay);
}

/**
 * The skeleton goes once the page has drawn something to read: after `ready` with text in its main
 * content (3 s at most), or, without the bridge (production today, or a bot check), once the
 * finished page shows any text (8 s at most). A page of another site goes 300 ms after it finished.
 */
function maybeHide(config: Config, step: Step, at: number) {
  const s = step.state;
  if (!s.pageLoading || s.hideScheduled) return;
  const own = isOwnOrigin(s.currentUrl, config.origin);
  if (!own) {
    if (s.finished && s.currentUrl) scheduleHide(step, at, TIMING.offOriginMs);
    return;
  }
  if (
    s.pageReady &&
    (s.textMain >= TIMING.readyTextChars || s.readyTextPassed)
  ) {
    scheduleHide(step, at, TIMING.afterReadyMs);
  } else if (!s.pageReady && s.noReadyPassed && s.textBody > 0) {
    scheduleHide(step, at, 0);
  }
}

function clearLoadFailure(step: Step) {
  cancel(step, "autoRetry");
  set(step, { loadFailed: false, failureSource: null, retryCount: 0 });
}

function showLoadFailure(step: Step, source: "web" | "signIn", detail: string) {
  log(step, "load-failure-lock", { source, detail });
  set(step, { loadFailed: true, failureSource: source });
  fx(step, { type: "dismissKeyboard" });
  scheduleRetry(step);
}

function scheduleRetry(step: Step) {
  timer(
    step,
    "autoRetry",
    step.state.retryCount < 6 ? TIMING.retryMs : TIMING.slowRetryMs,
  );
}

function finishSignIn(config: Config, step: Step, at: number) {
  const s = step.state;
  const fromWeb = s.signIn === "webFallback";
  cancel(step, "enter", "sheetClosed");
  set(step, {
    phase: "signedIn",
    signIn: "idle",
    message: null,
    pending: null,
    renewing: false,
  });
  clearLoadFailure(step);
  fx(step, { type: "flushCookies" });
  log(step, "signed-in", { from: fromWeb ? "web-sign-in" : "hand-off" });
  // Back must never walk through the identity provider to /sign: a new web view, with no history.
  if (fromWeb) remount(config, step, at);
}

function failSignIn(step: Step, message: string) {
  const s = step.state;
  cancel(step, "enter");
  if (s.renewing) {
    set(step, { renewing: false, pending: null });
    return;
  }
  if (s.phase !== "signedOut" || s.signIn !== "entering") return;
  log(step, "sign-in-failed", { message });
  set(step, {
    signIn: "idle",
    message,
    pending: null,
    source: null,
    pageLoading: false,
  });
}

function sessionEnded(step: Step, reason: string) {
  log(step, "session-ended", { reason });
  cancel(
    step,
    "enter",
    "signConfirm",
    "hideSkeleton",
    "watchdog",
    "skeletonDeadline",
    "noReady",
    "textWait",
    "readyText",
  );
  clearLoadFailure(step);
  set(step, {
    phase: "signedOut",
    signIn: "idle",
    tab: "home",
    renewing: false,
    pending: null,
    pageLoading: false,
    pageReady: false,
    source: null,
    webKey: step.state.webKey + 1,
    lastOwnUrl: null,
    currentUrl: null,
    keyboard: false,
  });
  fx(step, { type: "dismissKeyboard" }, { type: "clearSiteData" });
}

function presentSheet(
  config: Config,
  step: Step,
  pair: PkcePair,
  mode: HandoffMode,
  to: string,
  renewal: boolean,
) {
  let path = handoffPath(pair.challenge, config.platform, callbackName(mode));
  if (config.handoffAuto) path += "&auto=1";
  const url = renewal ? renewalUrl(config.origin, path) : baseUrl(config, path);
  set(step, { pending: { pair, mode, to, renewal }, callbackArrived: false });
  if (!renewal) set(step, { signIn: "sheet" });
  log(step, "sheet", { renewal, callback: callbackName(mode) });
  fx(step, { type: "openSheet", url, mode });
}

function startWebSignIn(config: Config, step: Step, at: number) {
  set(step, { signIn: "webFallback" });
  load(config, step, baseUrl(config, "/sign?native-sign-in=web"), at);
}

function enter(config: Config, step: Step, ticket: string, at: number) {
  const pending = step.state.pending;
  if (!pending) return;
  const to = pending.to;
  if (!pending.renewal) set(step, { signIn: "entering" });
  set(step, { pending: null, callbackArrived: true });
  cancel(step, "sheetClosed");
  timer(step, "enter", TIMING.enterMs);
  log(step, "enter", { to, renewal: pending.renewal });
  // The one request with the header the server requires (login CSRF). Never logged, never kept as a
  // page to reload: a retry or a restart loads `to` (lastOwnUrl is set from it, not from this).
  load(
    config,
    step,
    enterUrl(config.origin, ticket, pending.pair.verifier, to),
    at,
    { "OpenBot-Shell": config.platform },
  );
  if (isReloadableOwnUrl(baseUrl(config, to), config.origin))
    set(step, { lastOwnUrl: baseUrl(config, to) });
}

function onOffOriginFailure(
  config: Config,
  step: Step,
  at: number,
  detail: string,
  url: string,
) {
  log(step, "off-origin-load-failed", { url, detail });
  const s = step.state;
  if (s.phase === "signedIn") load(config, step, reloadTarget(config, s), at);
  else if (s.signIn === "webFallback")
    load(config, step, baseUrl(config, "/sign?native-sign-in=web"), at);
}

function onLoadFailure(
  config: Config,
  step: Step,
  at: number,
  url: string | null,
  detail: string,
) {
  const s = step.state;
  cancel(step, "watchdog");
  if (url && !isOwnOrigin(url, config.origin) && /^https?:/i.test(url)) {
    onOffOriginFailure(config, step, at, detail, url);
    return;
  }
  cancel(
    step,
    "hideSkeleton",
    "noReady",
    "textWait",
    "readyText",
    "skeletonDeadline",
  );
  set(step, { pageLoading: false, hideScheduled: false });
  if (s.phase === "signedOut" && s.signIn === "entering") {
    failSignIn(step, MESSAGES.notFinished);
    showLoadFailure(step, "signIn", "enter-failed");
    return;
  }
  if (!webVisible(s)) return;
  if (s.loadFailed && s.failureSource === "web") return;
  showLoadFailure(step, "web", detail);
}

function committedPage(step: Step) {
  const s = step.state;
  if (s.committed) return;
  set(step, { committed: true, commits: s.commits + 1 });
  cancel(step, "watchdog");
  if (s.failureSource === "web" || s.failureSource === null)
    clearLoadFailure(step);
  if (s.pageLoading)
    timer(step, "skeletonDeadline", TIMING.skeletonAfterCommitMs);
}

function handle(config: Config, step: Step, event: Event, at: number): void {
  const s = step.state;
  switch (event.type) {
    case "launch": {
      log(step, "launch", {
        session: event.hasSession,
        probe: Boolean(event.probeUrl),
      });
      if (event.probeUrl) {
        // Test hook: the header probe, loaded as `enter` is (with the header), to see where it goes.
        set(step, { phase: "signedIn" });
        load(config, step, event.probeUrl, at, {
          "OpenBot-Shell": config.platform,
        });
      } else if (event.hasSession) {
        set(step, { phase: "signedIn" });
        load(config, step, baseUrl(config), at);
      } else {
        set(step, { phase: "signedOut" });
      }
      return;
    }

    case "signInPressed": {
      if (s.phase !== "signedOut" || s.signIn !== "idle" || showsLock(s))
        return;
      set(step, { signIn: "probing", message: null });
      fx(step, { type: "fetchConfig", purpose: "sign-in" });
      return;
    }

    case "configAnswered": {
      if (s.signIn !== "probing") return;
      log(step, "hand-off-config", {
        mode: event.mode.kind,
        reason: "reason" in event.mode ? event.mode.reason : undefined,
      });
      if (event.mode.kind === "unreachable") {
        set(step, { signIn: "idle" });
        showLoadFailure(step, "signIn", "hand-off-config-no-answer");
        return;
      }
      set(step, { handoffMode: event.mode });
      if (event.mode.kind === "webSignIn") startWebSignIn(config, step, at);
      else presentSheet(config, step, event.pair, event.mode, "/", false);
      return;
    }

    case "renewalConfigAnswered": {
      if (!s.renewing || s.phase !== "signedIn") return;
      if (event.mode.kind === "scheme" || event.mode.kind === "https") {
        set(step, { handoffMode: event.mode });
        presentSheet(config, step, event.pair, event.mode, event.to, true);
      } else {
        if (event.mode.kind === "webSignIn")
          set(step, { handoffMode: event.mode });
        // No hand-off on this server: let the hosted sign-in run in the web view after all.
        set(step, { renewing: false, allowHostedOnce: event.intercepted });
        load(config, step, event.intercepted, at);
      }
      return;
    }

    case "sheetFailedToOpen": {
      const renewal = s.pending?.renewal ?? false;
      set(step, { pending: null });
      log(step, "sheet-failed-to-open");
      if (renewal) set(step, { renewing: false });
      else if (s.signIn === "sheet") startWebSignIn(config, step, at);
      return;
    }

    case "sheetResult": {
      const pending = s.pending;
      if (!pending) return;
      const ticket =
        event.result === "success" ? ticketFrom(event.url, pending.mode) : null;
      if (ticket) {
        enter(config, step, ticket, at);
        return;
      }
      log(step, "sheet-ended", { result: event.result, ticket: false });
      set(step, { pending: null });
      if (pending.renewal) set(step, { renewing: false });
      else if (s.signIn === "sheet")
        set(step, {
          signIn: "idle",
          message: event.result === "success" ? MESSAGES.notFinished : null,
        });
      return;
    }

    case "callbackUrl": {
      // Android: openbotshell:// (or the App Link) arrived. Any app can fire the scheme: only a
      // well-formed ticket for the sign-in this app started counts; anything else changes nothing.
      const pending = s.pending;
      const waiting =
        pending !== null &&
        (pending.renewal ? s.renewing : s.signIn === "sheet");
      const ticket = waiting ? ticketFrom(event.url, pending.mode) : null;
      if (!ticket) {
        log(step, "callback-ignored", {
          reason: waiting
            ? "no-ticket-or-wrong-callback"
            : "no-pending-sign-in",
        });
        return;
      }
      fx(step, { type: "closeSheet" });
      enter(config, step, ticket, at);
      return;
    }

    case "cancelWebSignIn": {
      if (s.signIn !== "webFallback") return;
      clearLoadFailure(step);
      cancel(step, "watchdog");
      set(step, { signIn: "idle", source: null, pageLoading: false });
      return;
    }

    case "page": {
      const message = event.message;
      switch (message.kind) {
        case "doc": {
          // A new document of the app's own origin committed: covered again until it draws. A late
          // one (the script's second chance at document end) only counts as the commit.
          if (webVisible(s) && !message.late) startCovering(step, at);
          committedPage(step);
          return;
        }
        case "text": {
          set(step, {
            textBody: Math.max(s.textBody, message.body),
            textMain: Math.max(s.textMain, message.main),
          });
          maybeHide(config, step, at);
          return;
        }
        case "tap":
          set(step, { lastTapAt: at });
          return;
        case "chrome":
          set(step, { pageColor: message.color, pageDark: message.dark });
          return;
        case "alert":
          fx(step, { type: "alert", message: message.message });
          return;
        case "open":
          set(step, { lastNavigation: message.handled ? "event" : "load" });
          return;
        case "bridge":
          handleBridge(config, step, message.message, at);
          return;
      }
      return;
    }

    case "navStart": {
      set(step, { pendingNavUrl: event.url });
      timer(step, "watchdog", TIMING.watchdogMs);
      return;
    }

    case "loadEnd": {
      cancel(step, "watchdog");
      set(step, {
        finished: true,
        currentUrl: event.url || s.currentUrl,
        pendingNavUrl: null,
      });
      committedPage(step);
      const now = step.state;
      if (
        now.pageLoading &&
        !now.pageReady &&
        isOwnOrigin(now.currentUrl, config.origin)
      ) {
        timer(step, "noReady", TIMING.noReadyMs);
        timer(step, "textWait", TIMING.textWaitMs);
      }
      maybeHide(config, step, at);
      return;
    }

    case "loadError": {
      const url = s.pendingNavUrl ?? event.url;
      set(step, { pendingNavUrl: null });
      onLoadFailure(config, step, at, url, `error ${event.code}`);
      return;
    }

    case "httpError": {
      if (event.status < 500) return;
      if (!isOwnOrigin(event.url, config.origin)) {
        log(step, "off-origin-http-error", { status: event.status });
        return;
      }
      onLoadFailure(config, step, at, event.url, `http ${event.status}`);
      return;
    }

    case "urlChanged": {
      const url = event.url;
      set(step, { currentUrl: url, canGoBack: event.canGoBack });
      if (isReloadableOwnUrl(url, config.origin))
        set(step, { lastOwnUrl: url });
      if (!isOwnOrigin(url, config.origin)) return;
      const path = pathOf(url);
      const onSign = isSignPath(path);
      if (s.phase === "signedIn" && onSign && !s.renewing && !s.bridgeSeen) {
        // A web app without the bridge (production today) says nothing; its /sign sends a signed-in
        // person on to "/". Still on /sign after 2.5 s, or no session cookie: the session ended.
        timer(step, "signConfirm", TIMING.signConfirmMs);
      } else if (
        s.phase === "signedOut" &&
        s.signIn === "entering" &&
        !onSign &&
        !path.startsWith("/api/")
      ) {
        fx(step, { type: "checkSession", reason: "entering-url" });
      } else if (
        s.phase === "signedOut" &&
        s.signIn === "webFallback" &&
        !onSign &&
        !path.startsWith("/api/")
      ) {
        fx(step, { type: "checkSession", reason: "web-fallback-url" });
      }
      return;
    }

    case "sessionChecked": {
      log(step, "session-check", {
        reason: event.reason,
        present: event.present,
      });
      switch (event.reason) {
        case "entering-url":
          if (
            event.present &&
            s.phase === "signedOut" &&
            s.signIn === "entering"
          )
            finishSignIn(config, step, at);
          return;
        case "web-fallback-url":
          if (
            event.present &&
            s.phase === "signedOut" &&
            s.signIn === "webFallback"
          )
            finishSignIn(config, step, at);
          return;
        case "enter-timeout":
          if (
            event.present &&
            s.phase === "signedOut" &&
            s.signIn === "entering"
          )
            finishSignIn(config, step, at);
          else failSignIn(step, MESSAGES.tooLong);
          return;
        case "sign-confirm": {
          if (s.phase !== "signedIn") return;
          const stillOnSign =
            isOwnOrigin(s.currentUrl, config.origin) &&
            isSignPath(pathOf(s.currentUrl));
          if (stillOnSign || !event.present) sessionEnded(step, "url-sign");
          return;
        }
      }
      return;
    }

    case "timer":
      handleTimer(config, step, event.name, at);
      return;

    case "network": {
      if (s.offline === event.offline) return;
      log(step, "network", { offline: event.offline });
      set(step, { offline: event.offline });
      if (event.offline) {
        fx(step, { type: "dismissKeyboard" });
        return;
      }
      if (s.loadFailed)
        handle(config, step, { type: "retry", automatic: true }, at);
      return;
    }

    case "retry": {
      if (!s.loadFailed) return;
      set(step, { retryCount: s.retryCount + 1 });
      log(step, "retry", {
        automatic: event.automatic,
        count: s.retryCount + 1,
        offline: s.offline,
      });
      if (!s.offline) {
        if (s.failureSource === "signIn") fx(step, { type: "ping" });
        else if (webVisible(s)) remount(config, step, at);
      }
      scheduleRetry(step);
      return;
    }

    case "pingAnswered": {
      if (event.ok && s.failureSource === "signIn") clearLoadFailure(step);
      return;
    }

    case "tabPressed": {
      if (s.phase !== "signedIn") return;
      fx(step, { type: "dismissKeyboard" });
      set(step, { tab: event.tab });
      const path = TAB_PATHS[event.tab];
      if (
        s.pageReady &&
        isOwnOrigin(s.currentUrl, config.origin) &&
        !showsLock(s)
      ) {
        // The page's own router, as OpenBot Desktop asks: `openbot:open`. The script loads the page
        // itself when nobody handled the event.
        fx(step, {
          type: "inject",
          script: `window.__openbotShellOpen && window.__openbotShellOpen(${JSON.stringify(path)}); true;`,
        });
      } else {
        set(step, { lastNavigation: "load" });
        load(config, step, baseUrl(config, path), at);
      }
      return;
    }

    case "keyboard":
      set(step, { keyboard: event.visible });
      return;

    case "processGone": {
      log(step, "web-process-gone");
      if (!webVisible(s)) return;
      set(step, { pageReady: false });
      remount(config, step, at);
      return;
    }

    case "appState": {
      if (!event.active) {
        fx(step, { type: "dismissKeyboard" }, { type: "flushCookies" });
        return;
      }
      if (s.pending && config.platform === "android" && !s.callbackArrived)
        timer(step, "sheetClosed", TIMING.sheetClosedMs);
      return;
    }

    case "interceptRenewal": {
      if (s.phase !== "signedIn" || s.renewing) return;
      set(step, { renewing: true });
      const to = renewalTo(event.url, config.origin);
      log(step, "renewal", { to });
      fx(step, {
        type: "fetchConfig",
        purpose: "renewal",
        to,
        intercepted: event.url,
      });
      return;
    }

    case "allowedOnce":
      set(step, { allowHostedOnce: null });
      return;

    case "openWindow": {
      const url = event.url;
      const tapped = at - s.lastTapAt < TIMING.tapWindowMs;
      if (isOwnOrigin(url, config.origin)) {
        if (isShellAuthUrl(url, config.origin)) return;
        if (s.pageReady)
          fx(step, {
            type: "inject",
            script: `location.assign(${JSON.stringify(url)}); true;`,
          });
        else load(config, step, url, at);
      } else if (/^https?:/i.test(url) && tapped) {
        fx(step, { type: "openBrowser", url });
      } else {
        log(step, "window-open-dropped", { url, tapped });
      }
      return;
    }

    case "fileDownload": {
      // Never in place of the page: the system share sheet takes the address.
      if (/^https?:/i.test(event.url))
        fx(step, { type: "share", url: event.url });
      return;
    }

    case "openBrowser":
      fx(step, { type: "openBrowser", url: event.url });
      return;

    case "openExternal":
      fx(step, { type: "openExternal", url: event.url });
      return;

    case "blocked":
      log(step, "navigation-blocked", { reason: event.reason, url: event.url });
      return;
  }
}

function handleBridge(
  config: Config,
  step: Step,
  message:
    | { type: "ready" }
    | { type: "signed-out" }
    | { type: "route"; path: string; tab: Tab | null; signedIn: boolean },
  at: number,
) {
  const s = step.state;
  switch (message.type) {
    case "ready": {
      set(step, { pageReady: true, bridgeSeen: true });
      // `ready` means the first page drew something, on a web app that has that change; keep our own
      // guard (text in the main content, 3 s at most) for one that does not.
      timer(step, "readyText", TIMING.readyTextMs);
      maybeHide(config, step, at);
      return;
    }
    case "route": {
      if (message.tab) set(step, { tab: message.tab });
      if (message.signedIn) {
        if (s.phase !== "signedIn" || s.renewing) {
          if (
            s.phase === "signedOut" &&
            (s.signIn === "entering" || s.signIn === "webFallback")
          )
            finishSignIn(config, step, at);
          else if (s.renewing) set(step, { renewing: false });
        }
      } else if (isSignPath(message.path)) {
        if (s.phase === "signedIn")
          timer(step, "signConfirm", TIMING.signConfirmMs);
        else if (s.signIn === "entering")
          failSignIn(step, MESSAGES.notFinished);
      }
      return;
    }
    case "signed-out": {
      if (s.phase === "signedIn") sessionEnded(step, "signed-out");
      else if (s.signIn === "entering") failSignIn(step, MESSAGES.notFinished);
      return;
    }
  }
}

function handleTimer(config: Config, step: Step, name: TimerName, at: number) {
  const s = step.state;
  switch (name) {
    case "watchdog":
      log(step, "load-watchdog");
      onLoadFailure(
        config,
        step,
        at,
        s.pendingNavUrl ?? s.currentUrl,
        "watchdog",
      );
      return;
    case "enter":
      fx(step, { type: "checkSession", reason: "enter-timeout" });
      return;
    case "sheetClosed":
      if (!s.pending || s.callbackArrived) return;
      log(step, "sheet-closed-without-callback");
      if (s.pending.renewal) set(step, { renewing: false, pending: null });
      else if (s.signIn === "sheet")
        set(step, { signIn: "idle", pending: null });
      return;
    case "noReady":
      set(step, { noReadyPassed: true });
      maybeHide(config, step, at);
      return;
    case "textWait":
      if (s.pageLoading && !s.pageReady) scheduleHide(step, at, 0);
      return;
    case "readyText":
      set(step, { readyTextPassed: true });
      maybeHide(config, step, at);
      return;
    case "hideSkeleton":
      if (s.pageLoading) {
        log(step, "skeleton-hidden", { ms: at - s.loadingSince });
        set(step, { pageLoading: false, hideScheduled: false });
      }
      return;
    case "skeletonDeadline":
      if (s.pageLoading) scheduleHide(step, at, 0);
      return;
    case "signConfirm":
      if (s.phase === "signedIn")
        fx(step, { type: "checkSession", reason: "sign-confirm" });
      return;
    case "autoRetry":
      handle(config, step, { type: "retry", automatic: true }, at);
      return;
  }
}

// The navigation policy (synchronous: the web view waits for it). ----------------------------------

export type NavigationRequest = {
  url: string;
  /** iOS gives it; Android with this app's patch to react-native-webview. Absent: treated as main frame. */
  isTopFrame?: boolean;
  /** iOS: "click" for a tapped link, "backforward", "other"… */
  navigationType?: string;
  /** Android with this app's patch. */
  hasGesture?: boolean;
};

export type NavigationDecision = { allow: boolean; events: Event[] };

export function decideNavigation(
  config: Config,
  s: State,
  request: NavigationRequest,
  at: number,
): NavigationDecision {
  const { url } = request;
  const scheme = schemeOf(url);
  const top = request.isTopFrame !== false;
  const tapped =
    request.navigationType === "click" ||
    request.hasGesture === true ||
    at - s.lastTapAt < TIMING.tapWindowMs;
  if (scheme === "openbotshell")
    return {
      allow: false,
      events: [{ type: "blocked", reason: "callback-scheme", url }],
    };
  if (scheme === "about" || scheme === "blob" || scheme === "data")
    return { allow: true, events: [] };
  if (scheme === "http" || scheme === "https") {
    if (!top) return { allow: true, events: [] };
    const own = isOwnOrigin(url, config.origin);
    if (own && isHostedSignIn(url, config.origin) && s.phase === "signedIn") {
      if (s.allowHostedOnce === url)
        return {
          allow: true,
          events: [{ type: "allowedOnce" }, { type: "navStart", url }],
        };
      if (!s.renewing && s.handoffMode?.kind !== "webSignIn")
        return { allow: false, events: [{ type: "interceptRenewal", url }] };
    }
    if (s.phase === "signedIn" && request.navigationType === "backforward") {
      if (!own || isSignPath(pathOf(url)) || pathOf(url).startsWith("/api/"))
        return {
          allow: false,
          events: [{ type: "blocked", reason: "back-out-of-app", url }],
        };
    }
    if (own) return { allow: true, events: [{ type: "navStart", url }] };
    if (s.phase === "signedOut" && s.signIn === "webFallback")
      return { allow: true, events: [{ type: "navStart", url }] };
    if (tapped) return { allow: false, events: [{ type: "openBrowser", url }] };
    return { allow: true, events: [{ type: "navStart", url }] };
  }
  if (
    top &&
    tapped &&
    (scheme === "mailto" || scheme === "tel" || scheme === "sms")
  )
    return { allow: false, events: [{ type: "openExternal", url }] };
  return {
    allow: false,
    events: [
      {
        type: "blocked",
        reason: tapped ? "scheme-not-allowed" : "no-tap",
        url: `${scheme}:`,
      },
    ],
  };
}
