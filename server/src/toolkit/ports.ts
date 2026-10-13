/**
 * What the toolkit needs from its host, named so the turn code can be read without the server.
 *
 * Each port is the narrowest shape the turn code calls. The server supplies the implementations; see
 * docs/specs/2026-10-13-toolkit-extraction.md for the full list and what each one replaces.
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
