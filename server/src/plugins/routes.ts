import { Hono, type MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { BROKERED_PROFILE, type BrokerProvider, toolkitOfFor } from "./access";
import type { AccountModeSwitch } from "./account-mode";
import type { ComposioBroker } from "./broker";
import { mountAppAccessRoutes } from "./route-groups/app-access";
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

export type {
  AuthorizationRefusal,
  ConnectingPersonCheck,
} from "./route-groups/context";
export { AUTHORIZATION_REFUSALS } from "./route-groups/context";

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
  composio?: { broker: ComposioBroker; provider: BrokerProvider },
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

  /**
   * WHICH broker this deployment's rows are reached through, as a name, read once for the whole
   * layer.
   *
   * HANDED IN WITH THE BROKER AND NEVER SNIFFED OFF IT. The broker declares what it can DO —
   * `grantIsLocal`, `authorizations` — deliberately not who it is, so a vendor name derived from it
   * would be the comparison `store.ts` argues against, made against a capability that two providers
   * are free to share.
   *
   * TAKEN FROM THE STORE, BECAUSE THE STORE'S ROWS ARE WHAT IS BEING NAMED. It used to be read off
   * the broker bag with `?? "composio"` behind it, and that `??` was a second answer to a question
   * `server/src/index.ts` had already answered. The two came apart exactly where it hurt: a
   * deployment with both API keys set and `OPENBOT_BROKER_PROVIDER` unset — legal, and what a
   * migration sits in — is wired with NO broker, so the bag is absent, so every `arcade://` row of
   * that deployment was parsed with Composio's parser. The account-mode switch refused those rows
   * as "not reached through a broker", the directory called enabled apps not enabled, connect fell
   * past its brokered branch in silence, and the operator was told to set COMPOSIO_API_KEY. The
   * store was built with the one name the deployment decided; reading it here means the parser
   * these routes use, the filter the store queries with and the name the page shows are one value.
   *
   * NO BROKER IS STILL NOT THE CASE THIS DECIDES. Rows outlive a key being unset, and the
   * Personal ⇄ Shared switch is wired from the shared bag rather than from the broker, so it
   * answers for such a row today — now with that row's own parser rather than Composio's.
   */
  const activeProvider: BrokerProvider = store.brokerProvider;
  /*
   * Said at construction, not at the first request. A store without this field is a stand-in rather
   * than a store, and one that got this far would have every brokered read dispatch on `undefined`
   * — four routes answering wrongly, none of them raising. Typed as present, so this catches only a
   * cast; it refuses rather than filling in a vendor, which is the whole of this file's bug.
   */
  if (!activeProvider) {
    throw new Error(
      "createPluginRoutes was given a plugin store with no brokerProvider. The store names the provider its rows belong to; the routes never guess one.",
    );
  }

  /**
   * The ACTIVE broker's name, as the sentences on this layer spell it.
   *
   * ONE READING FOR EVERY SENTENCE, AND NEVER A LITERAL. Every refusal below used to spell
   * "Composio" into the prose — the app that would not be removed, the app that would not be
   * enabled, the six ways a key app's connect fails, the consent with nowhere to send anybody, and
   * the confirm, re-check and disconnect tails. On an Arcade deployment each of them named a vendor
   * this deployment holds no key for and never dials, and sent the reader to check a key that does
   * not exist. The name comes off {@link activeProvider}'s profile, which is also what the brokered
   * reads below parse with, so the vendor a sentence names and the vendor a route actually reached
   * cannot come apart.
   *
   * THE PROFILE RATHER THAN A TERNARY, because {@link BROKERED_PROFILE} is where a provider's
   * vocabulary is written down once — a second spelling here is the second home the record exists
   * to prevent, and a provider added to it without being added here would typecheck.
   */
  const activeVendor = BROKERED_PROFILE[activeProvider].vendor;

  /**
   * Which app a brokered row is, read by the parser belonging to the broker this deployment runs.
   *
   * ONE PARSER PER PROVIDER, AND THEY ARE NOT INTERCHANGEABLE — the argument is {@link toolkitOfFor}'s
   * and is not repeated here. What this layer adds is that all four reads below used to call
   * Composio's parser by name, and that parser answers null for `arcade://Gmail` by design. Four
   * reads, four different wrong answers on an Arcade deployment, and not one of them a failure or a
   * log line: the account-mode switch refused a brokered app as "not reached through a broker", the
   * directory reported every enabled app as not enabled, the connect route fell past its brokered
   * branch in silence, and `brokeredAccountFor` — step one of confirm, re-check and disconnect —
   * refused a connected app before any account was resolved.
   *
   * A CLOSURE RATHER THAN THE DISPATCH SPELLED FOUR TIMES, which is how `shared-use-store.ts` holds
   * the same thing: the provider is read in one place, so a fifth read added below cannot be the one
   * that forgets to pass it.
   */
  const appOfUrl = (url: string): string | null =>
    toolkitOfFor(activeProvider, url);

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
      return `${slug} belongs to everyone. Only an admin can change it.`;
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
    activeProvider,
    activeVendor,
    appOfUrl,
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
  mountAppAccessRoutes(context);

  return routes;
}
