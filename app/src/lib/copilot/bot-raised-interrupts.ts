import type { Message } from "@ag-ui/core";
import { serverOwnedInterrupt } from "@/lib/copilot/server-owned-interrupts";

/** An AG-UI interrupt as the agent holds it, as much of it as this reads. */
export type HeldInterrupt = {
  id: string;
  reason?: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: unknown;
  metadata?: Record<string, unknown>;
};

/** One answer to an interrupt, as a run's `resume` carries it. */
export type InterruptAnswer = {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
};

/**
 * The interrupts a Bot raised itself, which only this app can answer.
 *
 * MOST WAITS ARE THE SERVER'S. An approval, a question or a sign-in OpenBot asks for is answered on
 * its own card and carried on by the server (`server-owned-interrupts.ts`). A Bot connected by its
 * address can also stop a run on its own: a harness that asks before it runs one of its own tools, a
 * graph's `interrupt()`. The server passes that through untouched, and passes its answer back
 * (`endpointResume` in the server's copilot.ts), so the run waits on whoever holds the conversation.
 * Left unanswered, the conversation is stuck: the agent refuses every later run ("pending
 * interrupt(s) not addressed by resume").
 */
export function botRaisedInterrupts<T extends HeldInterrupt>(
  pending: readonly T[],
): T[] {
  return pending.filter((interrupt) => !serverOwnedInterrupt(interrupt));
}

/**
 * Whether an interrupt asks yes or no: its answer is an object whose one required field is the
 * boolean `approved`. That is what an approval asked by a Bot's own harness looks like on AG-UI;
 * anything else has an answer this app cannot draw a form for, and can only be let go.
 */
export function asksForApproval(interrupt: HeldInterrupt): boolean {
  const schema = interrupt.responseSchema;
  if (!schema || typeof schema !== "object") return false;
  const { properties, required } = schema as {
    properties?: Record<string, { type?: unknown } | undefined>;
    required?: unknown;
  };
  return (
    properties?.approved?.type === "boolean" &&
    Array.isArray(required) &&
    required.length === 1 &&
    required[0] === "approved"
  );
}

/** The call an interrupt is about, from the conversation: its name and its arguments as sent. */
export function interruptedCall(
  interrupt: HeldInterrupt,
  messages: readonly Message[],
): { name: string; args: string } | undefined {
  if (!interrupt.toolCallId) return undefined;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const call = message.toolCalls?.find(
      (candidate) => candidate.id === interrupt.toolCallId,
    );
    if (call)
      return { name: call.function.name, args: call.function.arguments };
  }
  return undefined;
}

/**
 * The `resume` that answers every interrupt the agent holds, given the person's decision on those
 * the Bot raised. A run must address all of them at once, so one decision covers each approval the
 * Bot asked for in that step; an interrupt that is not a yes or no is cancelled, which lets the
 * conversation go on.
 */
export function answersFor(
  pending: readonly HeldInterrupt[],
  approved: boolean,
): InterruptAnswer[] {
  return botRaisedInterrupts(pending).map((interrupt) =>
    asksForApproval(interrupt)
      ? { interruptId: interrupt.id, status: "resolved", payload: { approved } }
      : { interruptId: interrupt.id, status: "cancelled" },
  );
}
