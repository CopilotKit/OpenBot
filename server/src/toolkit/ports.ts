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
