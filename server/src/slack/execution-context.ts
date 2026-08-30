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

function protect(execution: SlackExecution): SlackExecution {
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
