import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { computerAccessOf } from "./access";
import type { ComputerGateway } from "./gateway";

export type ComputerStreamLocation =
  | { kind: "denied" }
  | { kind: "permitted"; baseUrl: string | undefined };

/**
 * The upgrade path has no Hono middleware, so it must make the same durable entitlement decision
 * before it even asks the gateway where a computer is. A missing or unreadable profile is not
 * distinguishable to this caller from an inaccessible Bot.
 */
export async function locateComputerStream(input: {
  profileStore: Pick<AgentProfileStore, "get"> | undefined;
  actor: AgentActor;
  botId: string;
  gateway: Pick<ComputerGateway, "locate"> | undefined;
}): Promise<ComputerStreamLocation> {
  let profile: AgentProfile | null | undefined;
  try {
    profile = await input.profileStore?.get(input.actor, input.botId);
  } catch {
    return { kind: "denied" };
  }

  if (
    !profile ||
    computerAccessOf({ computerAccess: profile.computerAccess }) !== "enabled"
  ) {
    return { kind: "denied" };
  }

  return {
    kind: "permitted",
    baseUrl: input.gateway
      ? await input.gateway.locate(input.botId)
      : undefined,
  };
}
