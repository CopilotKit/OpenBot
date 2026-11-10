import { NOT_RUN_AFTER_FAILURE } from "@openbot/shared/approval-outcomes";
import { calledTooEarly } from "@openbot/shared/tool-steps";
import { useMemo, useSyncExternalStore } from "react";
import { readOutcome } from "@/lib/computers/activity";
import {
  type PublishedSandboxed,
  sandboxedKeys,
} from "@/lib/sandboxed/queries";
import { queryClient } from "@/query-client";
import { GALLERY_COMPONENTS } from "./gallery-registry";

/**
 * The browser's half of a step's rules (`shared/tool-steps.ts`): which calls draw a component, the
 * component asked for too early that is neither drawn nor answered as drawn, and a computer's actions
 * in one step taken one at a time and stopped at the first failure.
 */

/** A message as these rules read it: an assistant message carries its step's calls. */
type StepMessage = {
  id?: string;
  role: string;
  toolCalls?: readonly { id: string; function: { name: string } }[];
  toolCallId?: string;
  content?: unknown;
};

/**
 * Which tools draw a component in the conversation: this build's gallery, its cards that ask the
 * person included, and the components authored in this OpenBot that are published.
 *
 * Read from the gallery each time, not once: the registry is filled when its modules load.
 */
export function componentTest(
  published: readonly Pick<PublishedSandboxed, "name">[] = [],
): (name: string) => boolean {
  const authored = new Set(published.map((component) => component.name));
  return (name) =>
    authored.has(name) ||
    GALLERY_COMPONENTS.some((component) => component.name === name);
}

/**
 * The same test for a component that draws: it follows the published components as the page loads
 * them, and never fetches them itself (`SandboxedTools` does). Read from the page's own query cache,
 * as the handlers read it, so a transcript drawn outside a query provider still has its answer.
 */
export function useComponentTest(): (name: string) => boolean {
  const published = useSyncExternalStore(
    (changed) => queryClient.getQueryCache().subscribe(changed),
    () =>
      queryClient.getQueryData<PublishedSandboxed[]>(sandboxedKeys.published()),
  );
  return useMemo(() => componentTest(published), [published]);
}

/** The same test, from what the page has loaded of the published components when a call arrives. */
export function componentTestNow(): (name: string) => boolean {
  return componentTest(
    queryClient.getQueryData<PublishedSandboxed[]>(sandboxedKeys.published()),
  );
}

/**
 * Whether a component call is answered as asked for too early, instead of being drawn: its step
 * also asked for another kind of call, so what it shows was written before that call's result.
 */
export function drawnTooEarlyIn(
  messages: readonly StepMessage[] | undefined,
  toolCallId: string | undefined,
  isComponent: (name: string) => boolean = componentTestNow(),
): boolean {
  if (!messages || !toolCallId) return false;
  return calledTooEarly(messages, toolCallId, isComponent);
}

/**
 * One step's computer actions on one computer: the last one's turn, and where in the step the first
 * one that failed was asked for.
 */
type StepLine = { tail: Promise<void>; failedAt?: number };

/** Each step's line, by computer and step. Only the most recent are kept; a step is soon over. */
const lines = new Map<string, StepLine>();
const KEPT = 200;

/** Whether a computer action's answer says it did not happen as asked. */
function didNotWork(result: unknown): boolean {
  if (typeof result === "string") return readOutcome(result)?.ok === false;
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false
  );
}

/**
 * Take a computer action in its step's order, and only if nothing before it in the step failed.
 *
 * ONE AT A TIME, IN ORDER. Each action waits for the one asked for before it in its step, on the
 * same computer, whatever the SDK does with the calls: it runs them one after another today, and
 * nothing in the protocol says it must. Each step's line is kept here, in the tab that runs the
 * step, because that is the only place that sees the step whole; the server's gate sees one call at
 * a time, from any replica, and the computer takes its actions one at a time in the order they
 * reach it.
 *
 * STOPPED AT THE FIRST FAILURE. An action after one that did not work is answered as not run
 * ({@link NOT_RUN_AFTER_FAILURE}), not thrown: a thrown handler ends the Bot's turn with nothing
 * said. An earlier action of the step already answered as failed, by this tab or by the server's
 * continuation, counts too.
 *
 * A call outside any step it can find (no conversation, or one that does not hold it) is taken as
 * it is.
 */
export async function inStepOrder<T>(
  where: {
    computerId: string;
    messages: readonly StepMessage[] | undefined;
    toolCallId: string | undefined;
  },
  act: () => Promise<T>,
): Promise<T | typeof NOT_RUN_AFTER_FAILURE> {
  const { computerId, messages, toolCallId } = where;
  const holder = messages?.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === toolCallId),
  );
  if (!messages || !toolCallId || !holder?.id || !holder.toolCalls)
    return act();
  const step = holder.toolCalls;
  const at = step.findIndex((call) => call.id === toolCallId);
  const key = `${computerId}\n${holder.id}`;
  const line: StepLine = lines.get(key) ?? { tail: Promise.resolve() };
  lines.delete(key);
  lines.set(key, line);
  if (lines.size > KEPT) {
    const oldest = lines.keys().next().value;
    if (oldest !== undefined) lines.delete(oldest);
  }
  const failed = () => {
    line.failedAt = Math.min(line.failedAt ?? at, at);
  };
  const before = line.tail;
  let done = () => {};
  line.tail = new Promise<void>((resolve) => {
    done = resolve;
  });
  try {
    await before;
    if (
      (line.failedAt !== undefined && line.failedAt < at) ||
      failedBefore(messages, step, at)
    )
      return NOT_RUN_AFTER_FAILURE;
    try {
      const result = await act();
      if (didNotWork(result)) failed();
      return result;
    } catch (error) {
      failed();
      throw error;
    }
  } finally {
    done();
  }
}

/** Whether a computer action asked for earlier in the step already has an answer that failed. */
function failedBefore(
  messages: readonly StepMessage[],
  step: readonly { id: string; function: { name: string } }[],
  at: number,
): boolean {
  const earlier = step
    .slice(0, at)
    .filter((call) => call.function.name.startsWith("computer_"))
    .map((call) => call.id);
  return messages.some(
    (message) =>
      message.role === "tool" &&
      typeof message.toolCallId === "string" &&
      earlier.includes(message.toolCallId) &&
      didNotWork(message.content),
  );
}
