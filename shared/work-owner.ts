import { randomUUID } from "node:crypto";

export function workOwner(
  role: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const host = environment.HOSTNAME?.trim();
  const suffix = randomUUID().slice(0, 8);
  return host ? `${role}/${host}-${suffix}` : `${role}/${suffix}`;
}
