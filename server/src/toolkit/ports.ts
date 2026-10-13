import type { AuditEventInput } from "../audit";

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
 * Where a turn writes what it refused or did, for the audit trail.
 *
 * A sink rather than the store, so turn code never touches the database. The server's sink is
 * `auditSink` in audit.ts, which redacts the payload the same way every other write does.
 */
export type AuditSink = {
  record: (event: AuditEventInput) => Promise<void>;
};
