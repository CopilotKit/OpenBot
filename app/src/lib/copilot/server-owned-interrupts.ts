import { OPENBOT_WAITING_METADATA } from "@openbot/shared/waiting";

/** An AG-UI interrupt as the agent holds it, as much of it as this reads. */
type HeldInterrupt = {
  id: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Whether an interrupt is one the server answers itself: an approval, a question or a sign-in its
 * Bot stopped for, which carries what it waits on under `OPENBOT_WAITING_METADATA`. The person
 * answers it on its card and the server carries the conversation on; nothing in this app resumes it.
 */
export function serverOwnedInterrupt(interrupt: HeldInterrupt): boolean {
  const waiting = interrupt.metadata?.[OPENBOT_WAITING_METADATA];
  return !!waiting && typeof waiting === "object";
}

/**
 * Whether the server holds this tool call: the run that made it stopped on the server's own wait for
 * it (a take-over, a secret, a sign-in), and the server carries the conversation on once the person
 * has done their part, page open or not.
 *
 * Such a call has no result yet, so the SDK hands it to this app's handler as well. The handler must
 * not act on it: asked again, a sign-in opened a second form, and the answer this app would give
 * went into the conversation beside the server's. It waits as a held step does
 * (`WAITING_FOR_PERSON`), and its card draws from the server's request.
 */
export function heldByServer(
  agent: { pendingInterrupts?: readonly HeldInterrupt[] } | undefined,
  toolCallId: string | undefined,
): boolean {
  if (!toolCallId) return false;
  return (agent?.pendingInterrupts ?? []).some(
    (interrupt) =>
      (interrupt.toolCallId ?? interrupt.id) === toolCallId &&
      serverOwnedInterrupt(interrupt),
  );
}

/**
 * Let go of the interrupts the server answers, so the person's next message is sent.
 *
 * AN INTERRUPT THE AGENT REPLAYED STAYS ON IT. Opening a conversation replays its last run, and a
 * run that stopped for Allow once ends on an interrupt, which the AG-UI agent keeps as pending.
 * The server then carries that conversation on once the person decides, in a turn no browser
 * streams, so nothing ever tells the agent it was answered. Its next run is refused before it
 * leaves the browser ("Thread has 1 pending interrupt(s) not addressed by resume"), and the person's
 * message went nowhere: found in a task's conversation, the first thing typed after Allow once.
 *
 * Only those: an interrupt something else raised is still the agent's to resume, and is kept.
 */
export function releaseServerOwnedInterrupts<T extends HeldInterrupt>(agent: {
  pendingInterrupts: T[];
}): void {
  const kept = agent.pendingInterrupts.filter(
    (interrupt) => !serverOwnedInterrupt(interrupt),
  );
  if (kept.length !== agent.pendingInterrupts.length)
    agent.pendingInterrupts = kept;
}
