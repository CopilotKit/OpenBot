// The browser's extension messaging API, with no server traffic. The app has no @types/chrome, so the one member
// used is declared here.
type ExtensionMessaging = {
  runtime?: {
    sendMessage?(
      id: string,
      message: unknown,
      reply: (answer: unknown) => void,
    ): void;
    lastError?: unknown;
  };
};

/** `version` and `installId` come only when this copy is connected to this OpenBot; an unconnected copy answers `{ ok: true }`. */
export type DetectedRecorder = {
  id: string;
  version?: string;
  installId?: string;
};

/** A `throttled` refusal carries `retryAfterMs`: how long until the Recorder takes a connect from this OpenBot again. */
type ConnectCodeAnswer =
  | { ok: true; installId?: string; awaitingConfirmation?: boolean }
  | { ok: false; error: string; retryAfterMs?: number };

const DEFAULT_DETECT_TIMEOUT_MS = 1500;

function runtimeOf(): ExtensionMessaging["runtime"] {
  return (globalThis as { chrome?: ExtensionMessaging }).chrome?.runtime;
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
  return result;
}
