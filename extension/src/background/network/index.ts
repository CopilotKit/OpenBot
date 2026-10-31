// Network capture for the tabs a recording follows: Chrome's debugger (CDP's Network domain) on each followed tab and
// its frames, or, where Chrome refuses the debugger on a real site, the page-level fetch, XHR and WebSocket hook
// (fallback.ts), which this capture owns. No call is recorded on its own: each one that passes the screens (screen.ts)
// goes to the steps (steps.ts) with when it ran, and a write with its exchange masked with the shared rules (and marked
// when its body held what the person typed into a sensitive field in that tab), so it can be the save of the step that
// sent it. The AG-UI traffic (agent.ts) goes to the agent events as observations; an agent run is never a step's save.
// Nothing is stored or sent anywhere else.
import {
  type CapturedEvent,
  holdsTypedSecret,
  type JsonValue,
  maskNetworkEvent,
  scrubUrl,
} from "@openbot/shared/recorder-masking";
import { isRecordablePage } from "../../shared/origin";
import type { CaptureObservation } from "../agent/observation";
import type { StepCall } from "../steps";
import { createAgentCapture } from "./agent";
import {
  createRequestTracker,
  type Debuggee,
  MAX_POST_DATA_SIZE,
  type TrackedCall,
} from "./debugger";
import type { PageFallback } from "./fallback";
import { callSignature, createRepeatMemory, screenCall } from "./screen";

export type NetworkMode = "debugger" | "page" | "waiting" | "off";
export type NetworkCaptureDeps = {
  /** The OpenBot the recording's passes come from: its own calls are never a step's, and the AG-UI capture follows only its
   * chat with a Bot. Null once nothing records. */
  openbotUrl(): string | null;
  /** Whether a page the capture may attach to is one it records: a website, and not one the person keeps out of their
   * recordings. `isRecordablePage` when absent. */
  recordable?(url: string): boolean;
  /** A call that passed the screens, masked: for the steps to tell which they caused and which saved something. */
  call(call: StepCall): void;
  /** A write in flight (debugger only), from its start until `call` had it or it was screened out. */
  writeStarted(id: string, tabId: number, startedAt: number): void;
  writeEnded(id: string): void;
  status(mode: NetworkMode | "stopped", reason?: string): void;
  digests(): ReadonlySet<string>;
  /** The digests of what the person lately typed into sensitive fields in the tab (none when absent): a write whose body
   * held one is marked, as it is masked, as carrying what they entered. */
  typedSecrets?(tabId: number): ReadonlySet<string>;
  /** What the capture saw of AG-UI in a followed tab, raw, in the order it saw it (agent/observation.ts). */
  agent(observation: CaptureObservation): void;
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
  /** A page-level fallback event (Task 18) from a followed tab, already re-masked: dropped when it is a call to OpenBot
   * itself (the debugger never sees those either) or fails the screens, else handed to the steps like a debugger call. */
  recordPageEvent(tabId: number, event: CapturedEvent): Promise<void>;
  /** An AG-UI observation the page hook made in a followed tab: handed to the agent events like a debugger one. */
  recordPageAgent(tabId: number, observation: CaptureObservation): void;
  stop(): Promise<void>;
};

const WAITING =
  "What each step saves is recorded once this tab opens a website.";
const CANCELLED =
  "You closed Chrome's debugging bar, so what each step saves is no longer recorded.";
/** The popup's Network row already says what each step saves is captured from inside the page: this says why. */
const PAGE = "Chrome refused its debugger here.";
const refusedSentence = (message: string) =>
  `Chrome would not let the Recorder see what each step saves here (${message}).`;

/** OpenBot's CopilotKit runtime routes that run a Bot's agent or join its run: the runtime is mounted at /api/copilotkit
 * (server/src/copilot.ts) with REST routes only, `/agent/<id>/run` and `/agent/<id>/connect`. */
const OPENBOT_AGENT_RUN = /^\/api\/copilotkit\/agent\/[^/]+\/(?:run|connect)$/;
/** Where the page's CopilotKit asks OpenBot's runtime what it serves (`info`): a GET of /api/copilotkit/info, or, were
 * its transport to fall back to the single route, a POST of `{ method: "info" }` to /api/copilotkit. The answer names no
 * secret, only the runtime's version, mode and agents. */
const OPENBOT_RUNTIME_INFO = /^\/api\/copilotkit(?:\/info)?\/?$/;
/** CopilotKit Intelligence's client socket, as the page opens it from a run's join credentials (`<clientUrl>/websocket?
 * join_token=...`): on OpenBot's own origin when a deployment serves Intelligence's gateway there. */
const INTELLIGENCE_SOCKET = /\/websocket$/;

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};
/** The frames followed too (a cross-site iframe runs in its own session): an action there causes calls there. */
const FRAME_TARGETS = new Set(["iframe", "page"]);

type TabState = "attached" | "waiting" | "refused" | "page";

/** The parts of a network event the steps read. */
type NetworkValue = {
  url?: unknown;
  method?: unknown;
  status?: unknown;
  outcome?: unknown;
  completedAt?: unknown;
  durationMs?: unknown;
  request?: {
    headers?: Record<string, string>;
    body?: JsonValue;
  } | null;
  response?: { url?: unknown; body?: JsonValue } | null;
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether a write's body, as it was sent, held one of `typed` (what the person typed into a sensitive field in its tab),
 * which the masking took: read on the unmasked event, so only the answer goes on. */
function sentTyped(event: CapturedEvent, typed: ReadonlySet<string>): boolean {
  const request = (event.value as NetworkValue | null)?.request;
  const body = request?.body;
  const text =
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.text === "string"
      ? body.text
      : undefined;
  if (text === undefined || typed.size === 0) return false;
  const contentType = Object.entries(request?.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return holdsTypedSecret(text, contentType, typed);
}

/** A masked network event's exchange, as a step carries its save. */
function exchangeOf(value: NetworkValue): StepCall["exchange"] {
  return {
    url: typeof value.url === "string" ? value.url : "",
    status: typeof value.status === "number" ? value.status : null,
    body: value.request?.body ?? null,
    response: value.response?.body ?? null,
  };
}

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
  const recordable = deps.recordable ?? isRecordablePage;
  const repeats = createRepeatMemory();
  const tabs = new Map<number, TabState>();
  /** Each followed tab's main frame id (its page target's id), read once from Chrome when a document request needs it. */
  const topFrames = new Map<number, string>();
  let mode: NetworkMode | "stopped" = "off";
  /** stop() was called: nothing attaches, starts or emits from here on. */
  let ended = false;
  let listening = false;

  const send = (
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>,
  ) => chrome.debugger.sendCommand(target, method, params);

  /** OpenBot's own calls are never a step's call or save: its API hands the page secrets (a live Recorder connect code)
   * that must never reach Intelligence. */
  const ignore = (url: string): boolean => {
    const openbot = deps.openbotUrl();
    if (!openbot) return false;
    try {
      return new URL(url).origin === new URL(openbot).origin;
    } catch {
      return false;
    }
  };

  /** OpenBot's runtime `info` route: followed for CopilotKit's info call alone (openbotInfo). */
  const openbotInfo = (url: string): boolean => {
    if (!ignore(url)) return false;
    try {
      return OPENBOT_RUNTIME_INFO.test(new URL(url).pathname);
    } catch {
      return false;
    }
  };

  /** The AG-UI capture follows OpenBot's own page as it follows any other site's, but only in its chat with a Bot: the
   * runs and joins it posts to OpenBot's CopilotKit runtime, whose answers are the agent's events or the Intelligence
   * channel they stream on, an Intelligence client socket it opens with a run's join credentials, and the runtime's
   * answer to CopilotKit's `info` call (read for that alone: the page runs CopilotKit, so its clicks carry the open
   * Thread). Every other call to OpenBot stays ignored. The Recorder's own calls to OpenBot (its connection, its capture
   * pass) come from the extension, never from a tab, and match none of these. */
  const ignoreAgent = (url: string): boolean => {
    if (!ignore(url)) return false;
    try {
      const { pathname, searchParams } = new URL(url);
      return !(
        OPENBOT_AGENT_RUN.test(pathname) ||
        OPENBOT_RUNTIME_INFO.test(pathname) ||
        (INTELLIGENCE_SOCKET.test(pathname) && searchParams.has("join_token"))
      );
    } catch {
      return true;
    }
  };

  async function topFrame(tabId: number): Promise<string | undefined> {
    const known = topFrames.get(tabId);
    if (known !== undefined) return known;
    const targets = await chrome.debugger.getTargets().catch(() => []);
    const page = targets.find(
      (target) => target.tabId === tabId && target.type === "page",
    );
    if (page) topFrames.set(tabId, page.id);
    return page?.id;
  }

  const agent = createAgentCapture({
    send,
    ignore: ignoreAgent,
    infoOnly: openbotInfo,
    observe: (observation) => {
      if (!ended && mode !== "stopped") deps.agent(observation);
    },
    onRun: (key) => tracker.agentRun(key),
  });

  const tracker = createRequestTracker({
    ignore,
    send,
    repeats,
    topFrame,
    agent,
    call: (call: TrackedCall) => {
      if (ended || mode === "stopped") return;
      const { event, ...timing } = call;
      if (!event) {
        deps.call({ ...timing, url: scrubUrl(timing.url) });
        return;
      }
      const masked = maskNetworkEvent(event, { digests: deps.digests() });
      const value = (masked.value ?? {}) as NetworkValue;
      const exchange = exchangeOf(value);
      // A body that held what the person typed into a sensitive field reads [redacted] there now: the mark says so.
      const typed = sentTyped(
        event,
        deps.typedSecrets?.(timing.tabId) ?? new Set(),
      );
      deps.call({
        ...timing,
        url: exchange?.url ?? "",
        exchange: exchange && typed ? { ...exchange, typed: true } : exchange,
      });
    },
    writeStarted: (id, tabId, startedAt) => {
      if (!ended && mode !== "stopped") deps.writeStarted(id, tabId, startedAt);
    },
    writeEnded: (id) => deps.writeEnded(id),
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
    // The AG-UI capture first: the tracker asks it whether a request is an agent run.
    agent.onEvent(target, method, params);
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
      agent.clear();
      repeats.clear();
      unlisten();
      setMode("stopped", CANCELLED);
      for (const other of others)
        void chrome.debugger.detach({ tabId: other }).catch(() => undefined);
      return;
    }
    // target_closed: that tab is gone; the others keep capturing.
    tabs.delete(tabId);
    topFrames.delete(tabId);
    tracker.forgetTab(tabId);
    agent.forgetTab(tabId);
    repeats.forgetTab(tabId);
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
      if (!recordable(url)) continue;
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

  /** Tabs being attached by `attachLater`. A tab that joins at the page it shows can commit a page while its attach is
   * under way (a discarded tab loads again when it is switched to): a second attach would be refused by Chrome, as the
   * tab has a debugger already, and that refusal would mark the attached tab refused. */
  const attaching = new Set<number>();

  /** A tab that becomes recordable while the mode is not `page`: attach it, or fall back when nothing else is. */
  async function attachLater(tabId: number): Promise<void> {
    if (attaching.has(tabId)) return;
    attaching.add(tabId);
    try {
      await attachNow(tabId);
    } finally {
      attaching.delete(tabId);
    }
  }

  async function attachNow(tabId: number): Promise<void> {
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
      if (recordable(url)) await attachLater(tabId);
    },

    async onCommitted(tabId, frameId, url) {
      if (ended || mode === "stopped") return;
      if (mode === "page") {
        if (tabs.has(tabId)) await fallback?.onCommitted(tabId, frameId);
        return;
      }
      if (frameId === 0 && tabs.get(tabId) === "waiting" && recordable(url))
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

    async recordPageEvent(tabId, event) {
      if (ended) return;
      // The URLs are already masked, which keeps their origin. A call a redirect landed on OpenBot is OpenBot's too.
      const value = event.value as NetworkValue | null;
      const urls = [value?.url, value?.response?.url];
      if (urls.some((url) => typeof url === "string" && ignore(url))) return;
      if (!value || typeof value.url !== "string") return;
      const method = (
        typeof value.method === "string" ? value.method : "GET"
      ).toUpperCase();
      const body = value.request?.body;
      const text =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        typeof body.text === "string"
          ? body.text
          : undefined;
      // The hook reports a call once it is answered: it started its duration before that.
      const endedAt = number(value.completedAt) ?? event.timestamp;
      const startedAt = endedAt - Math.max(0, number(value.durationMs) ?? 0);
      const repeat = repeats.seen(
        tabId,
        callSignature(method, value.url, text),
        startedAt,
      );
      const outcome =
        value.outcome === "aborted" || value.outcome === "error"
          ? value.outcome
          : "ok";
      const headers = value.request?.headers;
      if (
        screenCall({
          url: value.url,
          method,
          outcome,
          headers:
            typeof headers === "object" && headers !== null ? headers : {},
          body: text,
          repeat,
        })
      )
        return;
      deps.call({
        tabId,
        startedAt,
        endedAt,
        method,
        url: value.url,
        ...(WRITE_METHODS.has(method) ? { exchange: exchangeOf(value) } : {}),
      });
    },

    recordPageAgent(tabId, observation) {
      if (ended || mode !== "page" || tabs.get(tabId) !== "page") return;
      deps.agent(observation);
    },

    async stop() {
      if (ended) return;
      ended = true;
      const attached = attachedTabs();
      const wasPage = mode === "page";
      tabs.clear();
      topFrames.clear();
      tracker.clear();
      agent.clear();
      repeats.clear();
      unlisten();
      for (const tabId of attached)
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
      if (wasPage || fallback?.active()) await fallback?.stop();
    },
  };
}
