import { capabilityRefusal } from "../admin/capabilities";
import { enterpriseControls } from "../admin/controls";
import type { AppInspection } from "./plugin-store/app-access";
import type { SharedUseStore } from "./shared-use-store";
import type { PluginStore } from "./store";

/**
 * A Bot's owner giving one of their own apps to their own Bot, without an administrator.
 *
 * WHY THIS IS NOT THE ADMINISTRATOR'S GRANT WITH THE CHECK TAKEN OFF. Three things differ, and each
 * is the reason the other two are safe:
 *
 * - WHICH APPS. Only one an administrator has added, switched on and opened to owners
 *   (`mcp_servers.owner_grants`, read through `ownerGrantsOf`). By default that is an app every
 *   person connects for themselves, and the built-in Routines. An owner never adds or switches on an
 *   app; that stays the administrator's.
 * - WHICH BOTS. Only one the person owns. A Bot nobody owns — a package's public Bot — reaches
 *   everybody on behalf of nobody, and stays an administrator's to equip.
 * - WHOSE ACCOUNT. The grant is marked `granted_as = owner`, and a call made under it always uses
 *   the asking person's own account, even on the owner's published Team Bot. See
 *   `credentialActorFor`. Publishing a Bot must not hand teammates the owner's mailbox.
 *
 * A SHARED APP IS THE ONE EXCEPTION TO "WHOSE ACCOUNT", and the two rules do not meet. A Shared app
 * runs on the deployment's one team account whoever the credential actor is (`accountFor` never
 * reads it for `shared`), so the owner marker cannot send it to a personal account; and a Personal
 * app never reaches here as Shared, so the marker keeps it on the asker's own. What a Shared app
 * needs instead is an audience, and where an administrator has let owners decide (`owner_grants =
 * any`, never the default for Shared) the owner's grant sets it: see {@link approveOwnersSharedUse}.
 *
 * And an administrator can switch the whole thing off for anybody through the `ownerApps`
 * capability, which every check here reads.
 */

/** Whether an administrator left this person able to give their own apps to their own Bots. */
export async function ownerAppsAllowed(userId: string): Promise<boolean> {
  return (
    (await enterpriseControls()?.capabilityFor(userId, "ownerApps")) ?? true
  );
}

/**
 * Why this person may not give this app to this Bot themselves, or null when they may. The sentence
 * is the one they read.
 *
 * ASKED OF THE INSPECTION, NOT RE-DERIVED. Whether the app is switched on and who it is open to are
 * the same answers the card and the Bot page drew; the Bot's owner is read here again because a 403
 * is decided on what is true now, not on what the page loaded a minute ago.
 */
export async function ownerGrantRefusal(
  store: Pick<PluginStore, "agentOwner" | "agentIsRegistered">,
  actorId: string,
  agentId: string,
  inspected: AppInspection,
): Promise<string | null> {
  const name = inspected.access.displayName;
  if (
    !(await store.agentIsRegistered(agentId)) ||
    (await store.agentOwner(agentId)) !== actorId
  )
    return "You can only give apps to Bots you own.";
  if (!(await ownerAppsAllowed(actorId))) return capabilityRefusal("ownerApps");
  if (inspected.unavailable !== null || !inspected.answeringId)
    return `${name} isn't turned on yet. Only an admin can turn it on.`;
  if (inspected.access.ownerGrants !== "any")
    return `Only an admin can give ${name} to a Bot.`;
  return null;
}

type OwnerSharedUseEvents = Pick<PluginStore, "recordAppAccessEvent">;

/**
 * The Shared-account audience a Bot owner's grant sets, and its row in the trail: who gave it, to
 * which Bot, on which app, and the audience. Nothing where the app is not Shared, its rule is not
 * `any`, or the Bot already holds an approval; see `approveOwnerGrant`.
 */
export async function approveOwnersSharedUse(
  events: OwnerSharedUseEvents,
  sharedUse: Pick<SharedUseStore, "approveOwnerGrant" | "appIdOf">,
  input: { botId: string; serverId: string; ownerId: string },
): Promise<void> {
  if (!input.serverId) return;
  const approval = await sharedUse.approveOwnerGrant({
    botId: input.botId,
    serverId: input.serverId,
    by: input.ownerId,
  });
  if (!approval) return;
  const appId = await sharedUse.appIdOf(input.serverId);
  await events.recordAppAccessEvent({
    eventType: "shared_use.owner_approved",
    targetId: appId,
    actorUserId: input.ownerId,
    payload: {
      bot: input.botId,
      server: appId,
      audience: approval.audience,
      members: approval.members,
      outsideInput: approval.outsideInput,
    },
  });
}

/**
 * Withdraw the audiences owners' grants set at an app — one Bot's, when its owner takes the app
 * back, or every Bot's, when an administrator stops letting owners decide — each with a row in the
 * trail. An administrator's approval is never touched.
 */
export async function withdrawOwnersSharedUse(
  events: OwnerSharedUseEvents,
  sharedUse: Pick<SharedUseStore, "withdrawOwnerApprovals" | "appIdOf">,
  input: {
    serverId: string;
    botId?: string;
    actorId: string;
    why: "owner_took_back" | "owner_grants_changed";
  },
): Promise<void> {
  const bots = await sharedUse.withdrawOwnerApprovals({
    serverId: input.serverId,
    ...(input.botId ? { botId: input.botId } : {}),
  });
  if (bots.length === 0) return;
  const appId = await sharedUse.appIdOf(input.serverId);
  for (const bot of bots)
    await events.recordAppAccessEvent({
      eventType: "shared_use.owner_withdrawn",
      targetId: appId,
      actorUserId: input.actorId,
      payload: { bot, server: appId, why: input.why },
    });
}
