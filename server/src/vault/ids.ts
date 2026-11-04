/**
 * The ids connections have in Intelligence, made from their natural keys, so two replicas (or the
 * upgrade copy and a live write) writing the same connection write the same record, and Intelligence's
 * one-per-natural-key rule and its one-per-id rule agree.
 */
import { createHash } from "node:crypto";

/** A short key from a natural key, within Intelligence's 200-character id limit. */
export function naturalId(prefix: string, parts: string[]): string {
  const plain = `${prefix}:${parts.join(":")}`;
  if (plain.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(plain)) return plain;
  return `${prefix}:h:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** The id a person's grant on an app has in Intelligence. */
export const grantId = (serverId: string, userId: string) =>
  naturalId("grant", [serverId, userId]);

/** The id a brokered account has in Intelligence. */
export const brokeredId = (
  provider: string,
  app: string,
  holder: "person" | "deployment",
  userId: string | null,
) => naturalId("broker", [provider, app, holder, userId ?? "deployment"]);

/** The id a person's broker identity has in Intelligence. */
export const identityId = (provider: string, userId: string) =>
  naturalId("identity", [provider, userId]);
