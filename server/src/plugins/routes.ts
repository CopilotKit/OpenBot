import { Hono, type MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import type { AccountModeSwitch } from "./account-mode";
import type { ComposioBroker } from "./broker";
import { mountComposioAppRoutes } from "./route-groups/composio-apps";
import { mountConnectionRoutes } from "./route-groups/connections";
import type {
  PluginConnectOptions,
  PluginRouteContext,
} from "./route-groups/context";
import { mountGrantRoutes } from "./route-groups/grants";
import { mountOAuthCallbackRoute } from "./route-groups/oauth-callback";
import { mountServerRoutes } from "./route-groups/servers";
import { mountSkillRoutes } from "./route-groups/skills";
import type { SharedUseStore } from "./shared-use-store";
import type { PluginStore } from "./store";

export type { ConnectingPersonCheck } from "./route-groups/context";

/**
 * The Plugins surface: what this deployment has added, and which Bots may use it.
 *
 * What a Bot can reach is an administrator's; what it is told is not. Adding an MCP server stores a
 * credential and opens a path into another company's system, and enabling one on a Bot is the same
 * decision one step later, so both are an administrator's. A skill only ever asks for tools the Bot
 * already holds, and every one of those calls is still decided, policy-checked and audited, so
 * anybody may write one for themselves and put it on a Bot they own.
 *
 * Reading is open to any signed-in person either way: what a Bot can reach is not a secret from the
 * person talking to it.
 *
 * The call endpoint asks again. The list of tools a run was offered is a snapshot taken when the run
 * started, so a grant revoked a second later is still in the model's hands. Deciding at call time is
 * what makes revocation immediate rather than nearly immediate, and it is where a refusal becomes a
 * row somebody can read.
 */
export function createPluginRoutes(
  store: PluginStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Whether the caller may act as the Bot they named. Required rather than optional, so a deployment
   * cannot end up calling somebody else's tools by leaving an argument off.
   */
  canUseBot: BotAccessCheck,
  /**
   * What the connect flow needs that the store does not hold: the key its state is sealed with, the
   * address a vendor sends people back to, and who still has access when they come back.
   *
   * Optional, so a deployment with no public URL configured simply cannot start a connect flow and
   * says so, rather than building a redirect URI out of a request header and failing at the vendor.
   *
   * Last, and after every required parameter, because that is the only position an optional argument
   * can hold. Both of these arrived on separate branches as "one more parameter", which is how a
   * positional list becomes a trap: every argument from here on is optional, so a misplaced one
   * typechecks and simply does nothing.
   */
  connect?: PluginConnectOptions,
  /**
   * The broker this deployment talks to when an app is connected for somebody rather than
   * registered by an administrator.
   *
   * Its own parameter rather than a field on `connect`, because nothing on that object applies
   * here. `connect` is the OAuth consent flow this deployment runs itself: the key its state is
   * sealed with, the redirect URI a vendor sends people back to, the access check the sessionless
   * callback asks. A brokered app uses none of it — the vendor holds the consent, so there is no
   * state to seal, no callback to land here and no redirect URI to publish. Folding it in would put
   * a field on an object whose every other field is about a flow it never enters.
   *
   * Optional, and last for the same reason `connect` is: a deployment with no Composio API key
   * configured simply has no broker, and the surface says so rather than pretending one exists. The
   * trap `connect` documents applies here with one more argument in it — every parameter from that
   * position on is optional, so a misplaced one typechecks and quietly does nothing.
   */
  composio?: { broker: ComposioBroker },
  /**
   * Who may use an app's one shared account, and the switch that makes an app Shared or Personal.
   *
   * Optional and last, for the reason `composio` is. Absent, the mode switch answers 503 and a
   * grant records no approval — which is only safe because without it nothing can turn an app
   * Shared in the first place.
   */
  shared?: { modes: AccountModeSwitch; use: SharedUseStore },
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  const skillActor = (context: { var: AppVariables }) => ({
    id: context.var.actor.id,
    isAdmin: context.var.actor.role === "admin",
  });

  /**
   * May this person write, edit or delete this skill?
   *
   * An administrator may touch anything. Everybody else may touch their own and nothing else, which
   * includes not editing a deployment skill an administrator wrote for everyone.
   */
  async function skillRefusal(
    context: { var: AppVariables },
    slug: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    const owner = await store.skillOwner(slug);
    if (owner === undefined) return null; // A new skill. Ownership is decided on the way in.
    if (owner === null) {
      return `${slug} belongs to this deployment. An administrator looks after it.`;
    }
    return owner === actor.id ? null : `${slug} is somebody else's skill.`;
  }

  const context: PluginRouteContext = {
    routes,
    store,
    requireUser,
    canUseBot,
    connect,
    composio,
    shared,
    actorEmail,
    skillActor,
    skillRefusal,
  };
  // In the order they were always registered, which is the order Hono matches them in.
  mountServerRoutes(context);
  mountComposioAppRoutes(context);
  mountConnectionRoutes(context);
  mountOAuthCallbackRoute(context);
  mountSkillRoutes(context);
  mountGrantRoutes(context);

  return routes;
}
