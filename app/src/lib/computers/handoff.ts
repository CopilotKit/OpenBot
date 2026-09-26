import type {
  BrowserChallenge,
  HandoffRequest,
} from "../../../../shared/computer-control";
import { callComputer, type ToolOutcome } from "./call";
import { cancelControl, readControl } from "./control";

export type PendingHandoff = { requestId: string; toolCallId: string };
const active = new Map<string, number>();
const key = (botId: string) => `openbot:pending-handoff:${botId}`;

/** Bookkeeping only. Never persist page text, credentials, or the human's input. */
export function pendingHandoff(botId: string): PendingHandoff | null {
  if (typeof sessionStorage === "undefined") return null;
  const text = sessionStorage.getItem(key(botId));
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value &&
      typeof value === "object" &&
      "requestId" in value &&
      typeof value.requestId === "string" &&
      "toolCallId" in value &&
      typeof value.toolCallId === "string"
      ? { requestId: value.requestId, toolCallId: value.toolCallId }
      : null;
  } catch {
    return null;
  }
}
export function rememberHandoff(
  botId: string,
  requestId: string,
  toolCallId?: string,
) {
  if (toolCallId && typeof sessionStorage !== "undefined")
    sessionStorage.setItem(
      key(botId),
      JSON.stringify({ requestId, toolCallId }),
    );
}
export function forgetHandoff(botId: string, requestId: string) {
  if (pendingHandoff(botId)?.requestId === requestId)
    sessionStorage.removeItem(key(botId));
}
export function hasActiveHandoff(botId: string, requestId: string) {
  return (active.get(`${botId}:${requestId}`) ?? 0) > 0;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** No human-control deadline: waiting expiry and all terminal outcomes belong to the server. */
export async function awaitHandoff(
  botId: string,
  requestId: string,
  signal?: AbortSignal,
  pollMs = 1000,
): Promise<ToolOutcome> {
  const identity = `${botId}:${requestId}`;
  active.set(identity, (active.get(identity) ?? 0) + 1);
  let lastRequest: HandoffRequest | undefined;
  let failures = 0;
  try {
    while (!signal?.aborted) {
      const state = await readControl(botId, requestId, signal).catch(
        () => null,
      );
      if (signal?.aborted) break;
      if (!state) {
        if (++failures >= 5)
          return {
            ok: false,
            requestId,
            reconnecting: true,
            reason:
              "The handoff could not be reached. Reopen this conversation and use Resume task to check this request again.",
          };
        await pause(pollMs, signal);
        continue;
      }
      failures = 0;
      if (state.request?.id !== requestId)
        return {
          ok: false,
          requestId,
          reason:
            "The computer did not return the requested handoff. Nothing has been marked complete.",
        };
      lastRequest = state.request;
      if (lastRequest.status === "completed") {
        const snapshot = await callComputer(
          botId,
          "/snapshot",
          { method: "POST" },
          signal,
        );
        if (!snapshot.ok)
          return {
            ...snapshot,
            requestId,
            handoffStatus: "completed",
            snapshotRequired: true,
          };
        const nextChallenge = challengeFrom(snapshot);
        if (nextChallenge) {
          if (nextChallenge.requestId === requestId)
            return {
              ok: false,
              requestId,
              reason:
                "The completed request still reports an active challenge. Check the browser before continuing.",
            };
          rememberHandoff(
            botId,
            nextChallenge.requestId,
            pendingHandoff(botId)?.toolCallId,
          );
          const next = await awaitHandoff(
            botId,
            nextChallenge.requestId,
            signal,
            pollMs,
          );
          return { ...next, challenge: nextChallenge };
        }
        return {
          ...snapshot,
          requestId,
          handoffStatus: "completed",
          result:
            "The person handed control back. This fresh snapshot describes the page now.",
        };
      }
      if (lastRequest.status !== "waiting" && lastRequest.status !== "taken") {
        return {
          ok: false,
          requestId,
          handoffStatus: lastRequest.status,
          reason:
            lastRequest.interruption ??
            `The handoff was ${lastRequest.status}. The person has not completed this request.`,
        };
      }
      await pause(pollMs, signal);
    }
    // Stop detaches a driver. Only a still-waiting request may be cancelled.
    if (signal?.reason === "detached")
      return {
        ok: false,
        stopped: true,
        requestId,
        reason: "The waiting view disconnected.",
      };
    const current = await readControl(
      botId,
      requestId,
      AbortSignal.timeout(2000),
    ).catch(() => null);
    if (
      current?.request?.id === requestId &&
      current.request.status === "waiting"
    )
      await cancelControl(botId, requestId).catch(() => null);
    return {
      ok: false,
      stopped: true,
      requestId,
      reason:
        "Stopped waiting. A person who has control keeps it until they hand back.",
    };
  } finally {
    const remaining = (active.get(identity) ?? 1) - 1;
    if (remaining) active.set(identity, remaining);
    else active.delete(identity);
  }
}

function requestFrom(result: ToolOutcome): HandoffRequest | undefined {
  const request = result.request;
  return request &&
    typeof request === "object" &&
    "id" in request &&
    typeof request.id === "string"
    ? (request as HandoffRequest)
    : undefined;
}

export async function runHelpRequest(
  botId: string,
  reason: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const stored = pendingHandoff(botId);
  if (toolCallId && stored?.toolCallId === toolCallId)
    return awaitHandoff(botId, stored.requestId, signal);
  const asked = await callComputer(
    botId,
    "/control/request",
    { method: "POST", body: { reason, ...(toolCallId ? { toolCallId } : {}) } },
    signal,
  );
  if (!asked.ok) return asked;
  const request = requestFrom(asked);
  if (!request)
    return {
      ok: false,
      reason: "The computer did not identify the handoff request.",
    };
  rememberHandoff(botId, request.id, toolCallId);
  return awaitHandoff(botId, request.id, signal);
}

export async function runNavigation(
  botId: string,
  url: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const stored = pendingHandoff(botId);
  if (toolCallId && stored?.toolCallId === toolCallId)
    return awaitHandoff(botId, stored.requestId, signal);
  const result = await callComputer(
    botId,
    "/navigate",
    { method: "POST", body: { url, ...(toolCallId ? { toolCallId } : {}) } },
    signal,
  );
  const challenge = challengeFrom(result);
  if (!challenge?.requestId) return result;
  rememberHandoff(botId, challenge.requestId, toolCallId);
  const resumed = await awaitHandoff(botId, challenge.requestId, signal);
  return { ...result, ...resumed, challenge };
}

function challengeFrom(result: ToolOutcome): BrowserChallenge | undefined {
  const value = result.challenge;
  if (
    !value ||
    typeof value !== "object" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("kind" in value) ||
    (value.kind !== "cloudflare" && value.kind !== "visible-challenge") ||
    !("reason" in value) ||
    typeof value.reason !== "string"
  )
    return undefined;
  return { requestId: value.requestId, kind: value.kind, reason: value.reason };
}

export async function runBrowserRead(
  botId: string,
  path: "/read" | "/snapshot",
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const stored = pendingHandoff(botId);
  if (toolCallId && stored?.toolCallId === toolCallId)
    return awaitHandoff(botId, stored.requestId, signal);
  const result = await callComputer(
    botId,
    path,
    path === "/snapshot" ? { method: "POST" } : undefined,
    signal,
  );
  const challenge = challengeFrom(result);
  if (!challenge) return result;
  rememberHandoff(botId, challenge.requestId, toolCallId);
  return {
    ...result,
    ...(await awaitHandoff(botId, challenge.requestId, signal)),
    challenge,
  };
}
