import {
  RECORDER_STORE_IDS,
  recorderStorePage,
} from "@openbot/shared/recorder-extension";
import {
  RECORDER_CONNECT_STATUS,
  RECORDER_PAGE_MESSAGES,
  type RecorderConnectWait,
  type RecorderPageMessage,
  type RecorderPageResult,
  type RecorderPageState,
} from "@openbot/shared/recorder-page";
import { z } from "zod";

// The browser's extension messaging API, with no server traffic. The app has no @types/chrome, so the members used
// are declared here. `webview` is not an extension's: it is how WebView2 (OpenBot Desktop's own app window on
// Windows) gives a page its host, documented at
// https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/javascript/webview
type ExtensionMessaging = {
  runtime?: {
    sendMessage?(
      id: string,
      message: unknown,
      reply: (answer: unknown) => void,
    ): void;
    lastError?: unknown;
  };
  webview?: unknown;
};

/** `version` and `installId` come only when this copy is connected to this OpenBot; an unconnected copy answers `{ ok: true }`. */
export type DetectedRecorder = {
  id: string;
  version?: string;
  installId?: string;
};

/**
 * `awaitingConfirmation`: the Recorder opened its Connect page and waits for the person's click there. `connected`: it
 * connected at once, with no Connect page, as it does for a trusted OpenBot (shared/recorder-page.ts
 * `TrustedConnectRule`). A `throttled` refusal carries `retryAfterMs`: how long until the Recorder takes a connect from
 * this OpenBot again.
 */
type ConnectCodeAnswer =
  | {
      ok: true;
      installId?: string;
      awaitingConfirmation?: boolean;
      connected?: true;
    }
  | { ok: false; error: string; retryAfterMs?: number };

const DEFAULT_DETECT_TIMEOUT_MS = 1500;

function chromeOf(): ExtensionMessaging | undefined {
  return (globalThis as { chrome?: ExtensionMessaging }).chrome;
}

function runtimeOf(): ExtensionMessaging["runtime"] {
  return chromeOf()?.runtime;
}

/** The extension's answer, or `undefined` when it did not answer (not installed, lastError, or a throw). */
function ask(id: string, message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const runtime = runtimeOf();
    if (!runtime?.sendMessage) return resolve(undefined);
    try {
      runtime.sendMessage(id, message, (answer) => {
        // Reading lastError is what tells Chrome the failure was handled.
        resolve(runtime.lastError ? undefined : answer);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function detectRecorder(
  ids: readonly string[],
  timeoutMs: number = DEFAULT_DETECT_TIMEOUT_MS,
): Promise<DetectedRecorder | null> {
  if (!runtimeOf()?.sendMessage || ids.length === 0)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = ids.length;
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const settle = (found: DetectedRecorder | null) => {
      if (found) {
        clearTimeout(timer);
        resolve(found);
      } else if (--pending === 0) {
        clearTimeout(timer);
        resolve(null);
      }
    };
    for (const id of ids) {
      void ask(id, { type: "openbot.ping" }).then((answer) => {
        if (!isRecord(answer) || answer.ok !== true) return settle(null);
        const found: DetectedRecorder = { id };
        if (typeof answer.version === "string") found.version = answer.version;
        if (typeof answer.installId === "string")
          found.installId = answer.installId;
        settle(found);
      });
    }
  });
}

export async function sendConnectCode(
  id: string,
  code: string,
): Promise<ConnectCodeAnswer> {
  const answer = await ask(id, { type: "openbot.connect", code });
  if (!isRecord(answer)) return { ok: false, error: "unreachable" };
  if (answer.ok !== true) {
    const refusal: ConnectCodeAnswer = {
      ok: false,
      error: typeof answer.error === "string" ? answer.error : "invalid",
    };
    if (
      typeof answer.retryAfterMs === "number" &&
      Number.isFinite(answer.retryAfterMs) &&
      answer.retryAfterMs >= 0
    )
      refusal.retryAfterMs = answer.retryAfterMs;
    return refusal;
  }
  const result: ConnectCodeAnswer = { ok: true };
  if (typeof answer.installId === "string") result.installId = answer.installId;
  if (answer.awaitingConfirmation === true) result.awaitingConfirmation = true;
  if (answer.connected === true) result.connected = true;
  return result;
}

/** How long a connect request waits for the person to confirm it in the Recorder's tab. */
export const CONFIRM_WINDOW_MS = 5 * 60_000;

/** Where this page's own connect has got to on the Recorder's Connect page (shared/recorder-page.ts), or `unknown` where
 * the Recorder did not say: one from before it could, which the page goes on waiting for, as it always did. */
export type ConnectWait = RecorderConnectWait | "unknown";

const connectWaitSchema = z.object({
  ok: z.literal(true),
  connect: z.enum(["waiting", "cancelled", "closed", "none"]),
}) satisfies z.ZodType<{ ok: true; connect: RecorderConnectWait }>;

/** Asks the Recorder `id` where the connect this page asked for has got to (`openbot.connect.status`). */
export async function askConnectWait(id: string): Promise<ConnectWait> {
  const answer = connectWaitSchema.safeParse(
    await ask(id, { type: RECORDER_CONNECT_STATUS }),
  );
  return answer.success ? answer.data.connect : "unknown";
}

const CONNECT_REFUSALS: Record<string, string> = {
  "not-https": "The Recorder only connects to OpenBot over HTTPS.",
  "pinned-elsewhere": "Your organization set the Recorder to another OpenBot.",
  "policy-invalid":
    "Your organization's Recorder policy names an OpenBot address the Recorder can't use. Ask your IT team.",
  busy: "The Recorder is finishing another connect request. Try again in a moment.",
  // A trusted OpenBot's connect, which the Recorder completes itself with OpenBot, with no Connect page.
  "exchange-refused":
    "OpenBot didn't accept the Recorder's connect request. Try again.",
  "openbot-unreachable":
    "The Recorder couldn't reach OpenBot to connect. Check your connection and try again.",
};
/** The Recorder can also answer `unreachable` or `invalid`, which have no sentence of their own. */
const CONNECT_REFUSAL_FALLBACK =
  "The Recorder didn't accept the request. Try again.";

/** The Recorder takes only so many connects from one OpenBot in ten minutes; its refusal says how long is left. */
function throttledSentence(retryAfterMs: number | undefined): string {
  const lead = "Too many connect requests in a short time.";
  if (retryAfterMs === undefined) return `${lead} Try again in a few minutes.`;
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `${lead} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** What a refused `openbot.connect` says to the person, wherever they asked to connect this browser. */
export function connectRefusalSentence(
  error: string,
  retryAfterMs?: number,
): string {
  if (error === "throttled") return throttledSentence(retryAfterMs);
  return CONNECT_REFUSALS[error] ?? CONNECT_REFUSAL_FALLBACK;
}

/* THE RECORDER IN THE BROWSER OPENBOT IS OPEN IN (shared/recorder-page.ts). */

/**
 * Whether this page can send a message to an extension at all. Chrome and Edge give a page `chrome.runtime.sendMessage`
 * only while an extension in them lists the page in its `externally_connectable`, as the Recorder lists every site, and
 * give it to a page already open the moment such an extension is added (both proven in Chrome 156, Edge 155 and
 * Chromium 151). So in a Chrome with no such extension there is no `sendMessage`, and that is not the same as a browser
 * that cannot hold the Recorder. Never in WebView2, OpenBot Desktop's own app window on Windows.
 */
export function canMessageExtensions(): boolean {
  const chrome = chromeOf();
  return chrome?.webview === undefined && !!chrome?.runtime?.sendMessage;
}

export type RecorderStore = "chrome" | "edge";

type UserAgentData = { brands?: { brand: string }[]; mobile?: boolean };

/**
 * The store a person adds the Recorder from in the browser this page is open in: Edge Add-ons in Microsoft Edge, the
 * Chrome Web Store in Google Chrome, from the brands the browser itself reports
 * (https://developer.mozilla.org/docs/Web/API/NavigatorUAData/brands). Null anywhere else: Safari, Firefox, OpenBot
 * Desktop's own app window (a WebKit view on macOS and Linux, WebView2 on Windows, which may report Edge's brand), and
 * Chrome or Edge on a phone, which take no extensions.
 */
export function recorderStoreHere(): RecorderStore | null {
  if (chromeOf()?.webview !== undefined) return null;
  const data = (globalThis.navigator as { userAgentData?: UserAgentData })
    ?.userAgentData;
  if (!data || data.mobile) return null;
  const brands = (data.brands ?? []).map(({ brand }) => brand);
  if (brands.includes("Microsoft Edge")) return "edge";
  if (brands.includes("Google Chrome")) return "chrome";
  return null;
}

type ConnectedPageState = Extract<RecorderPageState, { connected: true }>;

/** The Recorder's answer to `openbot.state`, checked against the contract's type before anything reads it. */
const pageStateSchema = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    phase: z.enum(["idle", "starting", "recording", "stopping"]),
    title: z.string().optional(),
    startedAt: z.number().optional(),
    actions: z.number(),
    lastStopped: z
      .object({
        recordingId: z.string(),
        title: z.string(),
        stoppedAt: z.number(),
        actions: z.number(),
        phrases: z.number(),
      })
      .optional(),
  }),
]) satisfies z.ZodType<RecorderPageState>;

const pageResultSchema = z.union([
  z.object({ ok: z.literal(true), state: pageStateSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]) satisfies z.ZodType<RecorderPageResult>;

/**
 * The Recorder in the browser OpenBot is open in, as the Browser button sees it:
 * - `connected`: it is connected to this OpenBot, and `state` is what it is doing.
 * - `unconnected`: it is here, and connected to no OpenBot or another one.
 * - `older`: a Recorder from before `openbot.state` (it refuses the message), which OpenBot cannot drive from here.
 * - `absent`: this is Chrome or Edge, the Recorder is not in it, and `page` is its store page there.
 * - `unreachable`: this page cannot reach an extension, or the Recorder has no store page yet for this browser.
 */
export type RecorderHere =
  | { kind: "connected"; id: string; state: ConnectedPageState }
  | { kind: "unconnected"; id: string }
  | { kind: "older"; id: string }
  | { kind: "absent"; store: RecorderStore; page: string }
  | { kind: "unreachable" };

/** The extension's answer, or `undefined` when it did not answer in `timeoutMs`. */
function askWithin(
  id: string,
  message: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void ask(id, message).then((answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

/** Where the person adds the Recorder to the browser this page is open in: its store there and its page in that store,
 * or null where it has no published store page (another browser, or a store it is not in yet). */
export function recorderStorePageHere(): {
  store: RecorderStore;
  page: string;
} | null {
  const store = recorderStoreHere();
  const id = store ? RECORDER_STORE_IDS[store] : undefined;
  return store && id ? { store, page: recorderStorePage(store, id) } : null;
}

/** Where the person adds the Recorder to this browser, while its store page there is published. */
function absentHere(): RecorderHere {
  const here = recorderStorePageHere();
  return here ? { kind: "absent", ...here } : { kind: "unreachable" };
}

/**
 * Asks each of `ids` (the Recorder ids this OpenBot trusts) what it is doing, with `openbot.state`. The Recorder
 * answers only the OpenBot it is connected to with its state, judged by the origin the browser reports for this page,
 * and every other page with `connected: false`. A copy connected here wins over one that is not.
 */
export async function findRecorderHere(
  ids: readonly string[],
  timeoutMs: number = DEFAULT_DETECT_TIMEOUT_MS,
): Promise<RecorderHere> {
  if (!canMessageExtensions()) return absentHere();
  const answers = await Promise.all(
    ids.map(async (id) => ({
      id,
      answer: await askWithin(
        id,
        { type: RECORDER_PAGE_MESSAGES.state } satisfies RecorderPageMessage,
        timeoutMs,
      ),
    })),
  );
  let found: RecorderHere | null = null;
  for (const { id, answer } of answers) {
    if (answer === undefined) continue;
    const state = pageStateSchema.safeParse(answer);
    if (state.success && state.data.connected)
      return { kind: "connected", id, state: state.data };
    if (state.success) found = { kind: "unconnected", id };
    else found ??= { kind: "older", id };
  }
  return found ?? absentHere();
}

/**
 * `openbot.record` or `openbot.stop` to the Recorder `id`: its answer, a refusal carrying its own sentence, or
 * `undefined` when it did not answer (it was removed or turned off since it was asked).
 */
export async function sendRecorderPage(
  id: string,
  message: RecorderPageMessage,
): Promise<RecorderPageResult | undefined> {
  const answer = pageResultSchema.safeParse(await ask(id, message));
  return answer.success ? answer.data : undefined;
}
