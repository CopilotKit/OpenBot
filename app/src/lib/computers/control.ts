import { tryClient } from "@/lib/client";

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. The public state is
 * always read live. The one local value is a bearer lease in sessionStorage, scoped to this browser
 * tab: observing that somebody else holds the wheel must never make their mouse authority reusable.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  /** What the Bot is waiting for, by name only. Present means show the masked prompt. */
  secretWanted?: string;
};

type ControlLeaseState = ControlState & { lease: string };
const LEASE_KEY = "openbot.computer-control";
const RENEW_AFTER_MS = 30_000;
const lastRenewed = new Map<string, number>();
const leaseStartedAt = new Map<string, string>();

function leaseKey(computerId: string) {
  return `${LEASE_KEY}.${computerId}`;
}

/** The private capability for this tab, never inferred from the public holder state. */
export function controlLease(computerId: string): string | undefined {
  try {
    return (
      globalThis.sessionStorage?.getItem(leaseKey(computerId)) ?? undefined
    );
  } catch {
    return undefined;
  }
}

function keepLease(computerId: string, lease: string, since: string) {
  try {
    globalThis.sessionStorage?.setItem(leaseKey(computerId), lease);
    lastRenewed.set(computerId, Date.now());
    leaseStartedAt.set(computerId, since);
  } catch {
    // Without tab-scoped storage this browser cannot safely claim it can drive.
  }
}

function forgetLease(computerId: string) {
  try {
    globalThis.sessionStorage?.removeItem(leaseKey(computerId));
  } catch {
    // It may already be unavailable; the in-memory renewal marker is still cleared below.
  }
  lastRenewed.delete(computerId);
  leaseStartedAt.delete(computerId);
}

async function callControl(
  computerId: string,
  path: string,
  method?: string,
  body?: unknown,
): Promise<ControlState | null> {
  const response = await tryClient(
    `/api/computers/${computerId}${path}`,
    method ? { method, ...(body === undefined ? {} : { body }) } : {},
  );
  if (!response.ok) return null;
  return (await response.json()) as ControlState;
}

export async function readControl(computerId: string) {
  let state = await callControl(computerId, "/control");
  if (!state) return null;

  const lease = controlLease(computerId);
  if (state.holder !== "human") {
    if (lease) forgetLease(computerId);
    return state;
  }
  if (!lease) return state;

  const renewedAt = lastRenewed.get(computerId) ?? 0;
  if (
    leaseStartedAt.get(computerId) === state.since &&
    Date.now() - renewedAt < RENEW_AFTER_MS
  )
    return state;
  const renewed = await callControl(computerId, "/control/renew", "POST", {
    lease,
  });
  if (!renewed) {
    forgetLease(computerId);
    return state;
  }
  state = renewed;
  lastRenewed.set(computerId, Date.now());
  leaseStartedAt.set(computerId, state.since);
  return state;
}

export async function takeControl(computerId: string) {
  const response = await tryClient(
    `/api/computers/${computerId}/control/take`,
    {
      method: "POST",
    },
  );
  if (!response.ok) return null;
  const { lease, ...state } = (await response.json()) as ControlLeaseState;
  if (!lease) return null;
  keepLease(computerId, lease, state.since);
  return state;
}

export async function releaseControl(computerId: string) {
  const lease = controlLease(computerId);
  if (!lease) return null;
  try {
    return await callControl(computerId, "/control/release", "POST", {
      lease,
    });
  } finally {
    forgetLease(computerId);
  }
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
  const lease = controlLease(computerId);
  if (!lease) return;
  inputQueue = inputQueue
    .then(() =>
      tryClient(`/api/computers/${computerId}/human/${kind}`, {
        method: "POST",
        body: { ...body, lease },
      }),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}
