import type { SharedUseStore } from "./shared-use-store";

export type SharedAppsAfterChange = {
  approved: { serverId: string; title: string }[];
  needsApproval: { serverId: string; title: string }[];
};

/**
 * What a change to who can reach a Bot means for the shared accounts it uses.
 *
 * AN ADMINISTRATOR'S CHANGE IS ITS OWN APPROVAL. They are the person who would be asked, so asking
 * them again on another screen is a second trip that decides nothing new. Anybody else's change goes
 * through — publishing is the owner's call — and the shared calls it would widen are named, so the
 * screen can offer to ask rather than let the first refusal be the way anybody finds out.
 */
export async function afterExposureChange(
  sharedUse: SharedUseStore | undefined,
  actor: { id: string; role: string },
  botId: string,
): Promise<SharedAppsAfterChange> {
  if (!sharedUse) return { approved: [], needsApproval: [] };
  if (actor.role === "admin")
    return {
      approved: await sharedUse.reapprove(botId, actor.id),
      needsApproval: [],
    };
  const short = await sharedUse.shortfall(botId);
  return {
    approved: [],
    needsApproval: short.map(({ serverId, title }) => ({ serverId, title })),
  };
}
