import type { HeadlessTool } from "./headless-tools";
import type { AuditInitiator } from "./initiator";

/**
 * What the toolkit needs from its host, named so the turn code can be read without the server.
 *
 * Each port is the narrowest shape the turn code calls. The server supplies the implementations.
 */

/**
 * Whether a turn may start, and the signal that stops it if that changes while it runs.
 *
 * Throws to refuse: a paused Bot, or a person without "Use Bots" or on a model off the allowlist.
 * Resolves with a signal that aborts when the Bot is paused mid-turn, joined with the caller's own
 * signal when there is one.
 */
export type TurnAdmission = (input: {
  ownerUserId: string;
  agentId: string;
  signal?: AbortSignal;
}) => Promise<AbortSignal>;

/**
 * The display components a Bot can draw in a turn with no browser, so it can still answer with a
 * chart. The server's catalog is `headlessComponentCatalog` in components/headless.ts.
 */
export type ComponentCatalog = {
  /** Every component's tool name, so a turn can tell which of its tool calls drew one. */
  names: ReadonlySet<string>;
  /** The component tools this Bot is offered, decided as the browser would decide them. */
  toolsForTurn: (input: {
    agentId: string;
    ownerUserId: string;
    initiator: AuditInitiator;
  }) => Promise<HeadlessTool[]>;
};

/**
 * The conversation's run lock.
 *
 * ONE RUN AT A TIME PER CONVERSATION, taken before anything is streamed. The platform hands the lock
 * out through an ordinary authenticated call and hands back the token that proves it: a run that
 * skips this and starts streaming is refused, because it is claiming to be a run nobody was told
 * about. That is what every delivery did before this existed, and the refusal read like a platform
 * limitation rather than a missing step.
 *
 * Taken with `NX`, so a conversation somebody else is already running in refuses rather than queues.
 * That is the right answer and the hop simply waits its turn: it is released back to the queue and
 * tried again, which is a wait rather than a failure.
 */
export type ThreadLock = {
  /**
   * The run id the platform issued, or null when somebody else is running in this conversation.
   *
   * ITS OWN ID, NOT THE ONE ASKED FOR. That id is what the gateway checks every streamed event
   * against, so a run that used the local one would be claiming to be a run nobody was told about.
   */
  acquire: (input: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
  }) => Promise<{ runId: string } | null>;
  /** Keep it while the addressed Bot works. The lock expires on its own otherwise. */
  renew: (input: { threadId: string; runId: string }) => Promise<void>;
  /** Give it back, so the next run does not wait out the whole expiry. */
  release: (input: { threadId: string; runId: string }) => Promise<void>;
};
