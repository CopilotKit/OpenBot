// The ONLY listeners of runtime.onMessage, onMessageExternal and onConnect in the whole extension (MV3 needs them
// registered synchronously at top level, and one place keeps the trust checks in one place).
import {
  type ExternalAnswer,
  type ExternalResponse,
  type ExternalToBackground,
  type PageResponse,
  type PageToBackground,
  PORT_CONTENT,
  PORT_OFFSCREEN,
  parseContentMessage,
  parseExternalMessage,
  parsePageConnectDecide,
} from "../protocol/messages";
import {
  type ConnectionLoss,
  handleConnectionMessage,
  handleExternalConnect,
} from "./connection";
import {
  answerOpenBotPage,
  isOpenBotPageMessage,
  type OpenBotPageControls,
} from "./openbot-page";

export type RouterHandlers = {
  page(
    message: PageToBackground,
    sender: chrome.runtime.MessageSender,
  ): Promise<PageResponse>;
  external(
    message: ExternalToBackground,
    sender: chrome.runtime.MessageSender,
  ): Promise<ExternalResponse>;
  contentPort(port: chrome.runtime.Port): void;
  offscreenPort(port: chrome.runtime.Port): void;
};

type RouterDeps = RouterHandlers &
  OpenBotPageControls & {
    connected(): Promise<void>;
    disconnected(): Promise<void>;
    /** The recording controller's, for a connection an approved Connect (or OpenBot Desktop's connect) replaces. */
    connectionLost(loss: ConnectionLoss): Promise<void>;
  };

const CONNECTION_TYPES = new Set<string>([
  "page.connect.pending",
  "page.connect.decide",
  "page.disconnect",
  "page.desktop.available",
  "page.connect.desktop",
]);
const RECORDING_TYPES = new Set<string>([
  "page.state",
  "page.learning",
  "page.record",
  "page.stop",
  "page.restart",
  "page.notice",
  "page.notice.dismiss",
  "page.kept.discard",
  "page.voice",
  "page.narration",
  "page.site",
]);

const UNKNOWN: PageResponse = { ok: false, error: "Unknown request." };
const FAILED: PageResponse = {
  ok: false,
  error: "The Recorder could not do that. Try again.",
};

function isOwnPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

function messageType(raw: unknown): string | null {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : null;
}

async function routePage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  deps: RouterDeps,
): Promise<PageResponse> {
  if (!isOwnPage(sender)) return { ok: false, error: "Not allowed." };
  const type = messageType(raw);
  if (type === null) return UNKNOWN;
  const message =
    type === "page.connect.decide"
      ? parsePageConnectDecide(raw)
      : (raw as PageToBackground);
  if (message === null) return UNKNOWN;
  if (CONNECTION_TYPES.has(type)) {
    // A connection a Connect approves in place of another person's, or another OpenBot's, ends the old one in the
    // recording controller first: what still runs with its token stops, kept for its person.
    const answer = await handleConnectionMessage(message, {
      connectionLost: deps.connectionLost,
    });
    if (answer === undefined) return UNKNOWN;
    // The follow-up runs after the connection changed: never fail the page on it. OpenBot Desktop's connect, with no
    // Connect page, is an approved Connect too.
    const connected =
      (message.type === "page.connect.decide" && message.approve) ||
      (message.type === "page.connect.desktop" &&
        "connected" in answer &&
        answer.connected);
    if (answer.ok && connected)
      await deps
        .connected()
        .catch((error) =>
          console.error("Recorder: reconnect follow-up failed", error),
        );
    if (answer.ok && message.type === "page.disconnect")
      await deps
        .disconnected()
        .catch((error) =>
          console.error("Recorder: disconnect follow-up failed", error),
        );
    return answer;
  }
  if (
    RECORDING_TYPES.has(type) ||
    (import.meta.env.RECORDER_VARIANT === "e2e" &&
      type === "RECORDER_E2E_FLOOD")
  )
    return deps.page(message, sender);
  return UNKNOWN;
}

/** openbot.ping and openbot.connect from a web page. A trusted OpenBot's connect, made with no Connect page, is an
 * approved Connect, and followed up as one; its answer says so (`connected`). */
async function routeConnect(
  message: ExternalToBackground,
  sender: chrome.runtime.MessageSender,
  deps: RouterDeps,
): Promise<ExternalResponse> {
  const answer = await handleExternalConnect(message, sender);
  if (answer.ok && "connected" in answer && answer.connected)
    await deps
      .connected()
      .catch((error) =>
        console.error("Recorder: reconnect follow-up failed", error),
      );
  return answer;
}

/** A port whose onMessage listeners only ever see messages that passed parseContentMessage. */
function filteredContentPort(port: chrome.runtime.Port): chrome.runtime.Port {
  const wrapped = new Map<unknown, (message: unknown) => void>();
  const onMessage = {
    addListener(
      listener: (message: unknown, port: chrome.runtime.Port) => void,
    ) {
      const guarded = (raw: unknown) => {
        const message = parseContentMessage(raw);
        if (message === null) return;
        listener(message, filtered);
      };
      wrapped.set(listener, guarded);
      port.onMessage.addListener(guarded);
    },
    removeListener(listener: unknown) {
      const guarded = wrapped.get(listener);
      if (!guarded) return;
      wrapped.delete(listener);
      port.onMessage.removeListener(guarded);
    },
    hasListener: (listener: unknown) => wrapped.has(listener),
  };
  const disconnectWrapped = new Map<unknown, () => void>();
  const onDisconnect = {
    addListener(listener: (port: chrome.runtime.Port) => void) {
      const guarded = () => listener(filtered);
      disconnectWrapped.set(listener, guarded);
      port.onDisconnect.addListener(guarded);
    },
    removeListener(listener: unknown) {
      const guarded = disconnectWrapped.get(listener);
      if (!guarded) return;
      disconnectWrapped.delete(listener);
      port.onDisconnect.removeListener(guarded);
    },
    hasListener: (listener: unknown) => disconnectWrapped.has(listener),
  };
  const filtered = {
    name: port.name,
    sender: port.sender,
    onMessage,
    onDisconnect,
    postMessage: (message: unknown) => port.postMessage(message),
    disconnect: () => port.disconnect(),
  } as unknown as chrome.runtime.Port;
  return filtered;
}

export function installRouter(deps: RouterDeps): void {
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    routePage(raw, sender, deps).then(
      (answer) => sendResponse(answer),
      () => sendResponse(FAILED),
    );
    return true;
  });

  chrome.runtime.onMessageExternal.addListener((raw, sender, sendResponse) => {
    const message = parseExternalMessage(raw);
    if (message === null) {
      sendResponse({ ok: false, error: "invalid" } satisfies ExternalResponse);
      return false;
    }
    const answer: Promise<ExternalAnswer> =
      message.type === "recorder.page-network" ||
      message.type === "recorder.page-agent"
        ? deps.external(message, sender)
        : isOpenBotPageMessage(message)
          ? answerOpenBotPage(message, sender, deps)
          : routeConnect(message, sender, deps);
    answer.then(
      (response) => sendResponse(response),
      () => sendResponse({ ok: false, error: "invalid" }),
    );
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_CONTENT) {
      deps.contentPort(filteredContentPort(port));
      return;
    }
    if (
      port.name === PORT_OFFSCREEN &&
      port.sender?.id === chrome.runtime.id &&
      port.sender.url === chrome.runtime.getURL("offscreen.html")
    ) {
      deps.offscreenPort(port);
      return;
    }
    port.disconnect();
  });
}
