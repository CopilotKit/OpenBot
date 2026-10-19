// Network capture for the tabs a recording follows: Chrome's debugger (CDP's Network domain) on each followed tab and
// its frames, or, where Chrome refuses the debugger on a real site, the page-level fetch and XHR hook (fallback.ts),
// which this capture owns. Every call is masked with the shared rules, trimmed to fit one Intelligence event, and
// emitted; nothing is stored or sent anywhere else.
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  maskNetworkEvent,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import { isRecordablePage } from "../../shared/origin";
import {
  createRequestTracker,
  type Debuggee,
  MAX_POST_DATA_SIZE,
} from "./debugger";
import type { PageFallback } from "./fallback";

export type NetworkMode = "debugger" | "page" | "waiting" | "off";
export type NetworkCaptureDeps = {
  /** The OpenBot the recording's passes come from: its own calls are never captured. Null once nothing records. */
  openbotUrl(): string | null;
  emit(event: CapturedEvent): void;
  status(mode: NetworkMode | "stopped", reason?: string): void;
  digests(): ReadonlySet<string>;
};
export type NetworkCapture = {
  start(tabId: number, url: string): Promise<NetworkMode>;
  addTab(tabId: number, url: string): Promise<void>;
  /** Every committed navigation in a followed tab (any frame): lets a tab that started on chrome:// attach once it reaches a site. */
  onCommitted(tabId: number, frameId: number, url: string): Promise<void>;
  /** After a service-worker restart: re-attach to every followed tab (detaching a stale session of ours first), resume
   * the page capture when that was the mode, and stay stopped when the person had closed the debugging bar. */
  resume(
    tabs: { tabId: number; url: string }[],
    previous: NetworkMode | "stopped",
  ): Promise<NetworkMode | "stopped">;
  /** A page-level fallback event (Task 18), already re-masked: dropped when it is a call to OpenBot itself (the debugger
   * never records those either), else trimmed to fit one event and emitted like a debugger event. */
  recordPageEvent(event: CapturedEvent): Promise<void>;
  stop(): Promise<void>;
};

const WAITING = "Network calls are recorded once this tab opens a website.";
const CANCELLED =
  "You closed Chrome's debugging bar, so network calls are no longer recorded.";
/** The popup's Network row already says the page's own calls are captured: this says why. */
const PAGE = "Chrome refused its debugger here.";
const refusedSentence = (message: string) =>
  `Chrome would not let the Recorder record network calls here (${message}).`;

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};
/** The frames whose calls are the page's own: cross-site iframes run in their own session. */
const FRAME_TARGETS = new Set(["iframe", "page"]);

type TabState = "attached" | "waiting" | "refused" | "page";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** In the e2e variant only: `storage.local.RECORDER_E2E_FORCE_ATTACH_REFUSAL` makes every attach refused (Task 26). */
async function forcedRefusal(): Promise<boolean> {
  if (import.meta.env.RECORDER_VARIANT !== "e2e") return false;
  const items = await chrome.storage.local.get(
    "RECORDER_E2E_FORCE_ATTACH_REFUSAL",
  );
  return items.RECORDER_E2E_FORCE_ATTACH_REFUSAL === true;
}

/** The capture owns the page-level fallback it is given: it alone starts it (when attach is refused on a real site),
 * forwards addTab and onCommitted to it while the mode is `page`, resumes it, and stops it. The recording controller
 * creates the fallback with createPageFallback() and hands it over here; it never calls the fallback itself. */
export function createNetworkCapture(
  deps: NetworkCaptureDeps,
  options: { fallback?: PageFallback } = {},
): NetworkCapture {
  const { fallback } = options;
  const tabs = new Map<number, TabState>();
  let mode: NetworkMode | "stopped" = "off";
  /** stop() was called: nothing attaches, starts or emits from here on. */
  let ended = false;
  let listening = false;

  const send = (
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>,
  ) => chrome.debugger.sendCommand(target, method, params);

  const ignore = (url: string): boolean => {
    const openbot = deps.openbotUrl();
    if (!openbot) return false;
    try {
      return new URL(url).origin === new URL(openbot).origin;
    } catch {
      return false;
    }
  };

  const tracker = createRequestTracker({
    ignore,
    send,
    emit: (event) => {
      if (ended || mode === "stopped") return;
      const masked = maskNetworkEvent(event, { digests: deps.digests() });
      deps.emit(trimEvent(masked, EVENT_BUDGET_BYTES).event);
    },
  });

  function setMode(next: NetworkMode | "stopped", reason?: string): void {
    mode = next;
    deps.status(next, reason);
  }

  const attachedTabs = () =>
    [...tabs].filter(([, tab]) => tab === "attached").map(([tabId]) => tabId);

  async function enable(target: Debuggee): Promise<void> {
    try {
      await send(target, "Network.enable", {
        maxPostDataSize: MAX_POST_DATA_SIZE,
      });
      await send(target, "Target.setAutoAttach", AUTO_ATTACH);
    } catch (error) {
      console.error("Recorder: network capture could not be turned on", error);
    }
  }

  function onEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) {
    // A flattened child session's events carry its sessionId beside the tab (Chrome 125; not in @types/chrome 0.3.4).
    const { tabId, sessionId } = source as Debuggee;
    if (
      tabId === undefined ||
      tabs.get(tabId) !== "attached" ||
      mode === "stopped"
    )
      return;
    const target: Debuggee = sessionId ? { tabId, sessionId } : { tabId };
    if (method === "Target.attachedToTarget") {
      const attached = params as
        | { sessionId?: unknown; targetInfo?: { type?: unknown } }
        | undefined;
      const child = attached?.sessionId;
      const type = attached?.targetInfo?.type;
      if (
        typeof child === "string" &&
        typeof type === "string" &&
        FRAME_TARGETS.has(type)
      )
        void enable({ tabId, sessionId: child });
      return;
    }
    tracker.onEvent(target, method, params);
  }

  function onDetach(source: chrome.debugger.Debuggee, reason: string) {
    const tabId = source.tabId;
    if (tabId === undefined || tabs.get(tabId) !== "attached") return;
    if (reason === "canceled_by_user") {
      // The person closed Chrome's debugging bar: capture ends for this recording, and never moves to page-level
      // patching behind their back (Review Focus 5).
      const others = attachedTabs().filter((other) => other !== tabId);
      tabs.clear();
      tracker.clear();
      unlisten();
      setMode("stopped", CANCELLED);
      for (const other of others)
        void chrome.debugger.detach({ tabId: other }).catch(() => undefined);
      return;
    }
    // target_closed: that tab is gone; the others keep capturing.
    tabs.delete(tabId);
    tracker.forgetTab(tabId);
  }

  function listen(): void {
    if (listening) return;
    listening = true;
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(onDetach);
  }

  function unlisten(): void {
    if (!listening) return;
    listening = false;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
  }

  /** Attaches to one tab and turns its network capture on; the refusal's message when Chrome says no. */
  async function attach(tabId: number): Promise<{ refused: string } | null> {
    if (await forcedRefusal())
      return { refused: "the e2e build refused the debugger" };
    listen();
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      return { refused: errorMessage(error) };
    }
    if (ended || mode === "stopped") {
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      return null;
    }
    tabs.set(tabId, "attached");
    await enable({ tabId });
    return null;
  }

  async function startFallback(refusal: string): Promise<NetworkMode> {
    const followed = [...tabs.keys()];
    if (fallback && (await fallback.start(followed))) {
      for (const tabId of followed) tabs.set(tabId, "page");
      unlisten();
      setMode("page", PAGE);
      return "page";
    }
    setMode("off", refusedSentence(refusal));
    return "off";
  }

  /** Attaches to every recordable tab of the list; the rest wait for their first website. With nothing attached and a
   * refusal on a real site, the page capture takes over. */
  async function follow(
    list: { tabId: number; url: string }[],
  ): Promise<NetworkMode> {
    let refusal: string | null = null;
    for (const { tabId, url } of list) {
      tabs.set(tabId, "waiting");
      if (!isRecordablePage(url)) continue;
      const refused = await attach(tabId);
      if (refused) {
        tabs.set(tabId, "refused");
        refusal ??= refused.refused;
      }
    }
    if (attachedTabs().length > 0) {
      setMode("debugger");
      return "debugger";
    }
    if (refusal !== null) return startFallback(refusal);
    setMode("waiting", WAITING);
    return "waiting";
  }

  /** A tab that becomes recordable while the mode is not `page`: attach it, or fall back when nothing else is. */
  async function attachLater(tabId: number): Promise<void> {
    const refused = await attach(tabId);
    if (!refused) {
      if (tabs.get(tabId) === "attached" && mode !== "debugger")
        setMode("debugger");
      return;
    }
    tabs.set(tabId, "refused");
    if (attachedTabs().length > 0) {
      console.error(
        "Recorder: Chrome refused the debugger on a followed tab",
        refused.refused,
      );
      return;
    }
    await startFallback(refused.refused);
  }

  return {
    async start(tabId, url) {
      tabs.clear();
      return follow([{ tabId, url }]);
    },

    async addTab(tabId, url) {
      if (ended || mode === "stopped" || tabs.has(tabId)) return;
      if (mode === "page") {
        tabs.set(tabId, "page");
        await fallback?.addTab(tabId);
        return;
      }
      tabs.set(tabId, "waiting");
      if (isRecordablePage(url)) await attachLater(tabId);
    },

    async onCommitted(tabId, frameId, url) {
      if (ended || mode === "stopped") return;
      if (mode === "page") {
        if (tabs.has(tabId)) await fallback?.onCommitted(tabId, frameId);
        return;
      }
      if (
        frameId === 0 &&
        tabs.get(tabId) === "waiting" &&
        isRecordablePage(url)
      )
        await attachLater(tabId);
    },

    async resume(list, previous) {
      tabs.clear();
      if (previous === "stopped") {
        setMode("stopped", CANCELLED);
        return "stopped";
      }
      if (previous === "page") {
        for (const { tabId } of list) tabs.set(tabId, "page");
        if (
          fallback &&
          (await fallback.start(list.map(({ tabId }) => tabId)))
        ) {
          setMode("page", PAGE);
          return "page";
        }
        tabs.clear();
      }
      // The sessions of the worker that went away lost their listeners and CDP domains with it: detach them first.
      const targets = await chrome.debugger.getTargets();
      for (const { tabId } of list)
        if (
          targets.some(
            (target) =>
              target.tabId === tabId &&
              target.attached &&
              target.extensionId === chrome.runtime.id,
          )
        )
          await chrome.debugger.detach({ tabId }).catch(() => undefined);
      return follow(list);
    },

    async recordPageEvent(event) {
      if (ended) return;
      // The URLs are already masked, which keeps their origin. A call a redirect landed on OpenBot is OpenBot's too.
      const value = event.value as {
        url?: unknown;
        response?: { url?: unknown } | null;
      } | null;
      const urls = [value?.url, value?.response?.url];
      if (urls.some((url) => typeof url === "string" && ignore(url))) return;
      deps.emit(trimEvent(event, EVENT_BUDGET_BYTES).event);
    },

    async stop() {
      if (ended) return;
      ended = true;
      const attached = attachedTabs();
      const wasPage = mode === "page";
      tabs.clear();
      tracker.clear();
      unlisten();
      for (const tabId of attached)
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
      if (wasPage || fallback?.active()) await fallback?.stop();
    },
  };
}
