import type { KnowledgeAclEntry, KnowledgeActor } from "./types";

export function canRead(
  actor: KnowledgeActor,
  entries: KnowledgeAclEntry[],
): boolean {
  let allowed = false;

  for (const entry of entries) {
    if (!matchesPrincipal(actor, entry.principal)) continue;
    if (entry.effect === "deny") return false;
    allowed = true;
  }

  return allowed;
}

function matchesPrincipal(actor: KnowledgeActor, principal: string): boolean {
  if (principal === `user:${actor.userId}`) return true;
  if (!principal.startsWith("group:")) return false;
  return actor.groups.includes(principal.slice("group:".length));
}
