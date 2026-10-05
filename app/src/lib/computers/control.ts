import { tryClient } from "@/lib/client";

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. Nothing here is cached:
 * who holds the wheel is a fact about this second, and a stale copy of it would be worse than no
 * copy — it would show somebody a screen they cannot drive, or let them think they can.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type { ComputerControlState as ControlState } from "../../../../shared/computer-control";
import type { ComputerControlState as ControlState } from "../../../../shared/computer-control";

async function callControl(
  computerId: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ControlState | null> {
  const response = await tryClient(
    `/api/computers/${encodeURIComponent(computerId)}${path}`,
    { ...(body === undefined ? {} : { method: "POST", body }), signal },
  );
  if (!response.ok) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || !("holder" in value)) return null;
  if (value.holder !== "bot" && value.holder !== "human") return null;
  return value as ControlState;
}

export function readControl(
  computerId: string,
  requestId?: string,
  signal?: AbortSignal,
) {
  return callControl(
    computerId,
    `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
    undefined,
    signal,
  );
}

export async function takeControl(computerId: string, requestId?: string) {
  const id =
    requestId ??
    (
      await callControl(computerId, "/control/request", {
        reason: "I want to take control of the browser.",
      })
    )?.request?.id;
  return id
    ? callControl(computerId, "/control/take", { requestId: id })
    : null;
}

export function releaseControl(computerId: string, requestId: string) {
  return callControl(computerId, "/control/release", { requestId });
}

export function cancelControl(computerId: string, requestId: string) {
  return callControl(computerId, "/control/cancel", { requestId });
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 *
 * The one call here that reports why it failed, because a person is waiting on the answer and a
 * silent failure would leave them typing into something that is not listening.
 */
export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/human/secret`,
      { method: "POST", body: { text } },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "That could not be entered." };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}

/**
 * Serializes human input requests without blocking the caller; ordering matters for typed secrets.
 */
let inputQueue: Promise<unknown> = Promise.resolve();

/**
 * Send one human input event. Returns immediately; delivery is ordered.
 */
export function sendHumanInput(
  computerId: string,
  kind: "click" | "type" | "key" | "scroll",
  body: Record<string, unknown>,
): void {
  inputQueue = inputQueue
    .then(() =>
      tryClient(`/api/computers/${computerId}/human/${kind}`, {
        method: "POST",
        body,
      }),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}
