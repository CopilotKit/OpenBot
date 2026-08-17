import type { AgentActor, AgentProfile } from "./profile-types";

export function canAccessAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;

  return (
    agent.visibility === "public" ||
    agent.ownerUserId === actor.id ||
    actor.role === "admin"
  );
}

export function canManageAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.systemOwned || agent.deletedAt !== null) return false;

  return agent.ownerUserId === actor.id || actor.role === "admin";
}

export const canRunAgent = canAccessAgent;
