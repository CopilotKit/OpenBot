import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentActor } from "../agents/profile-types";

export type SlackExecution = {
  readonly actor: Readonly<AgentActor>;
  readonly applicationUser: Readonly<{ id: string; name: string }>;
  readonly provider: "slack";
  readonly providerTenantId: string;
  readonly providerConversationId: string;
  readonly providerThreadId: string;
  channelsThreadId?: string;
  channelsConversationKey?: string;
  readonly messageText: string;
  agentId?: string;
};

const executionStorage = new AsyncLocalStorage<SlackExecution>();
const PROTECTED_FIELDS = [
  "actor",
  "applicationUser",
  "provider",
  "providerTenantId",
  "providerConversationId",
  "providerThreadId",
  "messageText",
] as const;

/**
 * Marks an execution that has already been through {@link protect}.
 *
 * Not enumerable, so the spread below cannot carry it onto a copy, and a symbol so nothing that
 * serialises an execution can see it.
 */
const PROTECTED = Symbol("openbot.slack.execution.protected");

/**
 * ONE EXECUTION PER TURN, however many times the context is established.
 *
 * Nesting is normal rather than exceptional: the channel establishes the context at ingress, and
 * `OpenBotChannelAgent.run` establishes it again when its observable is subscribed, because rxjs
 * subscribes lazily and may do so outside the call that built it. Copying on every entry would
 * give one turn two executions — the run writes `agentId` onto the object its closure holds, and a
 * reader in the other context finds an execution without one and refuses the turn's computer tools
 * with `SlackComputerContextError`.
 *
 * That failure has not been reachable only because `runAgentLoop` invokes tool handlers after
 * `agent.runAgent(...)` has returned, which lands them back in the outermost context, on the
 * object the run mutated. That is a property of somebody else's loop, not of this file, so the
 * invariant is held here instead: protecting an already-protected execution returns it unchanged.
 *
 * The first protect still copies, so the caller's own object is never written to by a run.
 */
function protect(execution: SlackExecution): SlackExecution {
  if ((execution as { [PROTECTED]?: true })[PROTECTED]) return execution;

  const protectedExecution: SlackExecution = {
    ...execution,
    actor: Object.freeze({ ...execution.actor }),
    applicationUser: Object.freeze({ ...execution.applicationUser }),
  };
  for (const field of PROTECTED_FIELDS) {
    Object.defineProperty(protectedExecution, field, {
      value: protectedExecution[field],
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  Object.defineProperty(protectedExecution, PROTECTED, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return protectedExecution;
}

/** Runs server-side Slack work without placing its private facts in agent inputs. */
export function runWithSlackExecution<T>(
  execution: SlackExecution,
  run: () => T,
): T {
  return executionStorage.run(protect(execution), run);
}

/** Reads the server-private execution facts for the current Slack turn. */
export function currentSlackExecution(): SlackExecution {
  const execution = executionStorage.getStore();
  if (!execution) {
    throw new Error("A Slack agent run requires a private execution context.");
  }
  return execution;
}

/** Reads an execution when rendering inside a Slack run; cold Channels recovery has none. */
export function maybeCurrentSlackExecution(): SlackExecution | null {
  return executionStorage.getStore() ?? null;
}
