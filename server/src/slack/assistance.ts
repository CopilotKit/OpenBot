import type { ChannelToolContext } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type {
  AssistanceStatus,
  ControlState,
  SecretRequest,
} from "../computer/schema";
import { ASSISTANCE_TTL_MS, mintAssistanceToken } from "./assistance-token";
import { currentSlackExecution } from "./execution-context";

export const ASSISTANCE_POLL_MS = 1_000;
const COMPENSATION_TIMEOUT_MS = 10_000;
const STOPPED = { ok: false, stopped: true, reason: "Stopped." } as const;
const DELIVERY_CLEARED = {
  ok: false,
  reason:
    "The Slack handoff could not be delivered. Its OpenBot assistance request was cleared; ask again if help is still needed.",
} as const;
const MAY_STILL_BE_PENDING = {
  ok: false,
  assistanceMayBePending: true,
  reason:
    "The Slack assistance flow could not be completed, and its OpenBot assistance request may still be pending. Open the coworker directly to clear it before asking again.",
} as const;
const DELIVERY_UNKNOWN = {
  ok: false,
  deliveryMayBePending: true,
  assistanceMayBePending: true,
  reason:
    "Slack may still deliver the secure assistance link, and its OpenBot request is still pending. Do not send another request until this one is checked.",
} as const;
const REQUEST_NOT_PENDING = {
  ok: false,
  reason:
    "The OpenBot assistance request could not be created safely. Its exact request generation is no longer pending; ask again if help is still needed.",
} as const;
const EXACT_CANCELLED = {
  ok: false,
  reason:
    "This exact OpenBot assistance request was already cancelled. Ask again only if help is still needed.",
} as const;
const EXACT_EXPIRED = {
  ok: false,
  reason:
    "This exact OpenBot assistance request expired without completion. Ask again only if help is still needed.",
} as const;
const EXACT_SUPERSEDED = {
  ok: false,
  reason:
    "This exact OpenBot assistance request was replaced by a newer request and did not complete.",
} as const;
const EXACT_UNKNOWN = {
  ok: false,
  assistanceMayBePending: true,
  reason:
    "OpenBot no longer knows the exact assistance request outcome. Check the coworker before asking again.",
} as const;

type WaitOutcome = "answered" | "cancelled" | "expired";
type SleepOutcome = "elapsed" | "aborted";
type SettledOperation<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "aborted" }
  | { kind: "expired" };

export type WaitForAssistanceOptions = {
  control: () => Promise<ControlState>;
  done: (state: ControlState) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<SleepOutcome>;
};

function abortAwareSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<SleepOutcome> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: SleepOutcome) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    timer = setTimeout(() => finish("elapsed"), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Settle a possibly hung operation without abandoning an unobserved rejection or live timer. */
function settleOperation<T>(
  run: () => Promise<T>,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<SettledOperation<T>> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  if (remainingMs <= 0) return Promise.resolve({ kind: "expired" });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SettledOperation<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "aborted" });
    const timer = setTimeout(() => finish({ kind: "expired" }), remainingMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(run)
      .then(
        (value) => finish({ kind: "value", value }),
        (error: unknown) => finish({ kind: "error", error }),
      );
  });
}

/** Poll one already-created assistance request for a finite, abortable window. */
export async function waitForAssistance({
  control,
  done,
  signal,
  timeoutMs = ASSISTANCE_TTL_MS,
  pollMs = ASSISTANCE_POLL_MS,
  now = Date.now,
  sleep = abortAwareSleep,
}: WaitForAssistanceOptions): Promise<WaitOutcome> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) return "cancelled";
    const polled = await settleOperation(control, deadline - now(), signal);
    if (polled.kind === "aborted") return "cancelled";
    if (polled.kind === "expired") return "expired";
    if (polled.kind === "error") throw polled.error;
    if (signal?.aborted) return "cancelled";
    if (done(polled.value)) return "answered";
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const slept = await sleep(Math.min(pollMs, remaining), signal);
    if (slept === "aborted" || signal?.aborted) return "cancelled";
  }
  return "expired";
}

export function computerControlUrl(appUrl: string, token: string): string {
  let configured: URL;
  try {
    configured = new URL(appUrl);
    const hostname = configured.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    if (
      configured.username ||
      configured.password ||
      (configured.protocol !== "https:" &&
        !(configured.protocol === "http:" && loopback))
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "OpenBot app URL must be HTTPS (or loopback HTTP for local development).",
    );
  }
  const url = new URL("/assist", configured);
  url.searchParams.set("token", token);
  return url.toString();
}

export type SlackAssistanceOptions = {
  appUrl: string;
  encryptionKey: string;
  now?: () => number;
};

async function assistanceUrl(
  options: SlackAssistanceOptions,
  issuedAt: number,
): Promise<string> {
  const execution = currentSlackExecution();
  if (!execution.agentId || !execution.channelsThreadId) {
    throw new Error("Slack assistance requires a pinned coworker thread.");
  }
  const token = await mintAssistanceToken(
    {
      openbotUserId: execution.actor.id,
      agentId: execution.agentId,
      channelsThreadId: execution.channelsThreadId,
    },
    options.encryptionKey,
    issuedAt,
  );
  return computerControlUrl(options.appUrl, token);
}

function assistanceMessage(reason: string, url: string) {
  return Message({
    fallbackText: `${reason} Open coworker control: ${url}`,
    children: [
      Section({ children: reason }),
      Actions({
        children: Button({ url, children: "Open coworker control" }),
      }),
    ],
  });
}

function actorAndAgent() {
  const execution = currentSlackExecution();
  if (!execution.agentId) {
    throw new Error("Slack assistance requires a pinned coworker.");
  }
  return {
    agentId: execution.agentId,
    actor: { id: execution.actor.id, userId: execution.actor.id },
  };
}

type AssistanceOutcome = Record<string, unknown> & { ok: boolean };

function hasExactHelpRequest(state: ControlState, requestId: string): boolean {
  return (
    state.holder === "bot" &&
    state.requested &&
    state.helpRequestId === requestId
  );
}

function hasExactSecretRequest(
  state: ControlState,
  requestId: string,
): boolean {
  return (
    state.holder === "bot" &&
    state.secretWanted !== undefined &&
    state.secretRequestId === requestId
  );
}

async function cancelCommittedRequest(
  gateway: ComputerGateway,
  agentId: string,
  actor: ActionActor,
  requestId: string,
  clearedOutcome: AssistanceOutcome,
  completedOutcome: AssistanceOutcome,
): Promise<AssistanceOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPENSATION_TIMEOUT_MS);
  try {
    const observed = await settleOperation(
      () => gateway.assistanceStatus(agentId, requestId),
      COMPENSATION_TIMEOUT_MS,
    );
    if (observed.kind === "value") {
      if (observed.value === "completed") return completedOutcome;
      if (observed.value === "human") return MAY_STILL_BE_PENDING;
      if (observed.value === "expired") return EXACT_EXPIRED;
      if (observed.value === "cancelled") return EXACT_CANCELLED;
      if (observed.value === "superseded") return EXACT_SUPERSEDED;
    }
    const cleared = await settleOperation(
      () =>
        gateway.cancelAssistance(agentId, actor, requestId, controller.signal),
      COMPENSATION_TIMEOUT_MS,
    );
    if (cleared.kind !== "value") return MAY_STILL_BE_PENDING;
    if (cleared.value.cancelled) return clearedOutcome;
    if (cleared.value.status === "completed") return completedOutcome;
    if (cleared.value.status === "expired") return EXACT_EXPIRED;
    if (cleared.value.status === "cancelled") return EXACT_CANCELLED;
    if (cleared.value.status === "superseded") return EXACT_SUPERSEDED;
    if (cleared.value.status === "unknown") return EXACT_UNKNOWN;
    return MAY_STILL_BE_PENDING;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function deliverCommittedRequest(
  gateway: ComputerGateway,
  agentId: string,
  actor: ActionActor,
  requestId: string,
  context: ChannelToolContext,
  message: ReturnType<typeof assistanceMessage>,
  remainingMs: number,
  completedOutcome: AssistanceOutcome,
): Promise<AssistanceOutcome | null> {
  if (context.signal?.aborted) {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      STOPPED,
      completedOutcome,
    );
  }
  const posted = await settleOperation(
    () => context.thread.post(message),
    remainingMs,
    context.signal,
  );
  if (posted.kind === "aborted" || posted.kind === "expired") {
    return DELIVERY_UNKNOWN;
  }
  if (posted.kind === "error") {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      DELIVERY_CLEARED,
      completedOutcome,
    );
  }
  return null;
}

async function waitForExactAssistance(options: {
  status: () => Promise<AssistanceStatus>;
  signal?: AbortSignal;
  deadline: number;
  now: () => number;
}): Promise<AssistanceStatus | "stopped"> {
  while (options.now() < options.deadline) {
    if (options.signal?.aborted) return "stopped";
    const polled = await settleOperation(
      options.status,
      options.deadline - options.now(),
      options.signal,
    );
    if (polled.kind === "aborted") return "stopped";
    if (polled.kind === "expired") return "expired";
    if (polled.kind === "error") throw polled.error;
    if (polled.value !== "pending" && polled.value !== "human") {
      return polled.value;
    }
    const remaining = options.deadline - options.now();
    if (remaining <= 0) return "expired";
    const slept = await abortAwareSleep(
      Math.min(ASSISTANCE_POLL_MS, remaining),
      options.signal,
    );
    if (slept === "aborted") return "stopped";
  }
  return "expired";
}

export async function requestSlackHelp(
  gateway: ComputerGateway,
  reason: string,
  context: ChannelToolContext,
  options: SlackAssistanceOptions,
) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + ASSISTANCE_TTL_MS;
  const { agentId, actor } = actorAndAgent();
  const url = await assistanceUrl(options, startedAt);
  if (context.signal?.aborted) return STOPPED;
  const requestId = crypto.randomUUID();
  const answered = {
    ok: true,
    result:
      "The person has finished and handed control back. Take a fresh snapshot: the page may have changed while they were driving.",
  };
  let state: ControlState;
  try {
    state = await gateway.requestHelp(agentId, actor, reason, requestId);
  } catch {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      REQUEST_NOT_PENDING,
      answered,
    );
  }
  if (!hasExactHelpRequest(state, requestId)) {
    return MAY_STILL_BE_PENDING;
  }
  if (now() >= deadline) {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      {
        ok: true,
        result:
          "Nobody took control. Say what you still need rather than trying to do it yourself.",
      },
      answered,
    );
  }
  const deliveryFailure = await deliverCommittedRequest(
    gateway,
    agentId,
    actor,
    requestId,
    context,
    assistanceMessage(reason, url),
    deadline - now(),
    answered,
  );
  if (deliveryFailure) return deliveryFailure;
  const expired = {
    ok: true,
    result:
      "Nobody took control. Say what you still need rather than trying to do it yourself.",
  };
  try {
    const outcome = await waitForExactAssistance({
      status: () => gateway.assistanceStatus(agentId, requestId),
      signal: context.signal,
      deadline,
      now,
    });
    if (outcome === "completed") return answered;
    if (outcome === "superseded") return EXACT_SUPERSEDED;
    if (outcome === "cancelled") return EXACT_CANCELLED;
    if (outcome === "unknown") return EXACT_UNKNOWN;
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      outcome === "stopped" ? STOPPED : expired,
      answered,
    );
  } catch {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      {
        ok: false,
        reason:
          "OpenBot could not confirm the assistance result. Its request was cleared; ask again if help is still needed.",
      },
      answered,
    );
  }
}

export async function requestSlackSecret(
  gateway: ComputerGateway,
  input: SecretRequest,
  context: ChannelToolContext,
  options: SlackAssistanceOptions,
) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + ASSISTANCE_TTL_MS;
  const { agentId, actor } = actorAndAgent();
  const url = await assistanceUrl(options, startedAt);
  if (context.signal?.aborted) return STOPPED;
  const requestId = crypto.randomUUID();
  const answered = {
    ok: true,
    result: `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`,
  };
  let state: ControlState;
  try {
    state = await gateway.requestSecret(agentId, actor, input, requestId);
  } catch {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      REQUEST_NOT_PENDING,
      answered,
    );
  }
  if (!hasExactSecretRequest(state, requestId)) {
    return MAY_STILL_BE_PENDING;
  }
  if (now() >= deadline) {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      {
        ok: true,
        result: `Nobody entered ${input.label}. Do not ask for it another way.`,
      },
      answered,
    );
  }
  const deliveryFailure = await deliverCommittedRequest(
    gateway,
    agentId,
    actor,
    requestId,
    context,
    assistanceMessage(`Open OpenBot to enter ${input.label}.`, url),
    deadline - now(),
    answered,
  );
  if (deliveryFailure) return deliveryFailure;
  const expired = {
    ok: true,
    result: `Nobody entered ${input.label}. Do not ask for it another way.`,
  };
  try {
    const outcome = await waitForExactAssistance({
      status: () => gateway.assistanceStatus(agentId, requestId),
      signal: context.signal,
      deadline,
      now,
    });
    if (outcome === "completed") return answered;
    if (outcome === "superseded") return EXACT_SUPERSEDED;
    if (outcome === "cancelled") return EXACT_CANCELLED;
    if (outcome === "unknown") return EXACT_UNKNOWN;
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      outcome === "stopped" ? STOPPED : expired,
      answered,
    );
  } catch {
    return cancelCommittedRequest(
      gateway,
      agentId,
      actor,
      requestId,
      {
        ok: false,
        reason:
          "OpenBot could not confirm the secret request result. Its request was cleared; ask again if it is still needed.",
      },
      answered,
    );
  }
}
