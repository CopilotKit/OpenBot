import {
  cancelComputerControl,
  getComputerControl,
  releaseComputerControl,
  requestComputerControl,
  sendComputerHumanInput,
  supplyComputerSecret,
  takeComputerControl,
} from "@/lib/api/generated/computers/computers";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

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

export type { ComputerControlState as ControlState } from "@openbot/shared/computer-control";

import type {
  ComputerControlState as ControlState,
  RequestHelpInput,
} from "@openbot/shared/computer-control";

/** A write's key: one per call, so a retry the network makes is the same write. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** The control state a call answered, or nothing when it failed or answered something else. */
async function controlFrom(
  call: Promise<unknown>,
): Promise<ControlState | null> {
  const value: unknown = await call.catch((error: unknown) => {
    // A stopped read is the caller's to see; any other failure is no answer.
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    return null;
  });
  if (!value || typeof value !== "object" || !("holder" in value)) return null;
  if (value.holder !== "bot" && value.holder !== "human") return null;
  return value as ControlState;
}

/**
 * The reason a request for the wheel gave, when the Bot raised it: what the Bot needs the person for. A person's own
 * take (`manual`) carries the app's own words for asking ("I want to take control of the browser."), and echoing them
 * back read as though the person had said them. Nothing then, and nothing for a request this state does not describe.
 */
export function botsReason(control: ControlState | null): string | undefined {
  return control?.request && control.request.source !== "manual"
    ? control.reason
    : undefined;
}

export function readControl(
  computerId: string,
  requestId?: string,
  signal?: AbortSignal,
) {
  return controlFrom(
    getComputerControl(
      organizationId(),
      computerId,
      requestId ? { requestId } : undefined,
      signal ? { signal } : {},
    ),
  );
}

export async function takeControl(computerId: string, requestId?: string) {
  const id =
    requestId ??
    (
      await controlFrom(
        requestComputerControl(
          organizationId(),
          computerId,
          {
            reason: "I want to take control of the browser.",
            // A person's own take, so nothing shows its reason back to them as though the Bot had asked.
            source: "manual",
          } satisfies RequestHelpInput,
          once(),
        ),
      )
    )?.request?.id;
  return id
    ? controlFrom(
        takeComputerControl(
          organizationId(),
          computerId,
          { requestId: id },
          once(),
        ),
      )
    : null;
}

export function releaseControl(computerId: string, requestId: string) {
  return controlFrom(
    releaseComputerControl(organizationId(), computerId, { requestId }, once()),
  );
}

export function cancelControl(computerId: string, requestId: string) {
  return controlFrom(
    cancelComputerControl(organizationId(), computerId, { requestId }, once()),
  );
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
    await supplyComputerSecret(organizationId(), computerId, { text }, once(), {
      fallback: "Couldn't type that into the page. Try again.",
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ClientError
          ? error.message
          : "Couldn't reach the Bot's computer. Try again.",
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
      sendComputerHumanInput(organizationId(), computerId, kind, body, once()),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}
