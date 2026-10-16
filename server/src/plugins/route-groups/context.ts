import type { Hono, MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../../agents/profile-policy";
import type { AppVariables } from "../../auth/guards";
import type { AccountModeSwitch } from "../account-mode";
import { brokerSentence, type ComposioBroker } from "../broker";
import { vendorSentence } from "../composio";
import type { SharedUseStore } from "../shared-use-store";
import type { PluginStore } from "../store";

/**
 * What the plugin route groups share. See `../routes.ts`, which builds one of these and mounts
 * every group on it in order.
 */

/**
 * Whether the person a consent was started for still has access to this deployment.
 *
 * A seam rather than an import, because these routes have no business knowing what a person is or
 * where the deny list lives — and because the answer has to come from the deployment as it is when
 * the callback lands, not from what was true when the flow started.
 *
 * False for somebody who was removed while they were away at the vendor's consent screen, and false
 * for a user id that names nobody at all. Both are the same refusal: there is no live person for
 * this grant to belong to.
 */
export type ConnectingPersonCheck = (userId: string) => Promise<boolean>;

/**
 * What somebody is told when the broker itself failed, and what is deliberately kept out of it.
 *
 * EVERY BROKERED ROUTE NEEDS THIS AND NONE OF THEM USED TO HAVE IT. A listing, a connect, a confirm
 * and a disconnect all end in a call to another company's API, and an unhandled rejection out of any
 * of them is a bare 500 with the vendor's thrown object on this deployment's console. That object is
 * the whole HTTP response — headers, trace ids, rate-limit counters — and the person reading the 500
 * gets none of it and no sentence either. A wrong `COMPOSIO_API_KEY` is the first failure a new
 * operator meets, and it is the one this used to answer worst.
 *
 * `vendorSentence` IS THE SAME ONE THE TRANSPORT USES, for the same reason it exists there: the
 * useful sentence — "Invalid API key", "No connected account found for user …" — is nested two
 * levels inside `cause` beside everything that must not be shown, so this reaches in for that one
 * string and takes nothing else. Null from it is a failure this deployment cannot explain, and the
 * caller's own generic sentence is what a reader gets instead of the vendor's placeholder.
 *
 * NOTHING FROM THE REQUEST OR THE ANSWER TRAVELS WITH IT. Not the API key, which never leaves the
 * adapter; not a connect link, which is a bearer capability handed to one browser; and not the
 * thrown object, whether by spreading it, stringifying it or logging it.
 *
 * 502 RATHER THAN 500, because nothing here broke: this deployment asked a third party and the third
 * party did not answer usefully, which is the same reading the dynamic-registration failure below
 * already gives.
 *
 * `./broker`'s `BrokerRefusalError` IS THE EXCEPTION, AND IT IS A WIDER ONE THAN IT WAS. It used to
 * be the one no-key state; it is now every refusal the broker layer AUTHORED — no key, an app whose
 * authorization config this deployment never created or cannot use, a consent the vendor answered
 * with nowhere to send anybody, a catalogue too large to be sure of. All of them share the property
 * that made the first one special: Composio answered, this deployment decided, and the sentence
 * already names the step that fixes it. So the message is passed through and the status stays 503,
 * which reads correctly for every one of them — the brokered surface is unavailable for this app
 * until somebody changes something here, rather than unavailable because a third party is down. The
 * generic sentence below is for failures this deployment genuinely cannot explain, and answering one
 * of these with it would tell an administrator to check a key that is fine.
 */
export function brokerRefusal(
  error: unknown,
  generic: string,
): { error: string; status: 502 | 503 } {
  const authored = brokerSentence(error);
  if (authored) return { error: authored, status: 503 };
  return { error: vendorSentence(error) ?? generic, status: 502 };
}

/**
 * What a reader is told when Composio would not answer with its directory.
 *
 * One constant because two routes make that call — browsing the catalogue and enabling an app out of
 * it — and a reader meeting the same failure through two doors should not meet two sentences. It
 * names the setting rather than quoting it: a key that was pasted with a space in it, or one for
 * another project, is the likeliest reason Composio will not talk to this deployment at all.
 */
export const DIRECTORY_UNAVAILABLE =
  "Composio would not answer with its app directory, and said nothing about why. Check that COMPOSIO_API_KEY is this project's key, and check Composio's status if it persists.";

/** What the connect flow needs that the store does not hold. See `createPluginRoutes`. */
export type PluginConnectOptions = {
  encryptionKey: string;
  /**
   * Whether the person a state names may still connect an account here.
   *
   * Required rather than optional, unlike everything else that arrived on this object as "one more
   * parameter". The callback is sessionless on purpose, so this is the ONLY thing asking whether
   * the identity in the state is still one this deployment recognises — and a deployment that
   * forgot to pass it would complete a consent for somebody who was removed ten minutes ago and
   * write a live refresh token nothing will ever revoke.
   */
  personHasAccess: ConnectingPersonCheck;
  /**
   * Whether this deployment holds a shared secret a Bot may present when calling a tool back.
   *
   * A boolean about configuration, never the secret. Without it, a Bot can only call back if it
   * holds a credential issued to it alone, and a Bot with neither is refused before the call ever
   * reaches the grant, the boundary or the trail. The Bots screen needs this to stop promising a
   * grant the deployment cannot honour.
   */
  botsMayCallBack?: boolean;
  publicUrl: string | undefined;
  /**
   * Where the app is, which is not where this API is.
   *
   * The callback lands here and has to send the person back to a page. A relative redirect would
   * put them on this server's origin, which locally is a Vite-less port that serves no pages at
   * all — so the flow would complete correctly and end on a 404.
   */
  appUrl: string | undefined;
};

/**
 * Everything a group of plugin routes is mounted with: the router they are added to, what
 * `createPluginRoutes` was given, and the per-request helpers more than one group asks.
 */
export type PluginRouteContext = {
  routes: Hono<{ Variables: AppVariables }>;
  store: PluginStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  connect: PluginConnectOptions | undefined;
  composio: { broker: ComposioBroker } | undefined;
  shared: { modes: AccountModeSwitch; use: SharedUseStore } | undefined;
  actorEmail: (context: { var: AppVariables }) => string;
  skillActor: (context: { var: AppVariables }) => {
    id: string;
    isAdmin: boolean;
  };
  skillRefusal: (
    context: { var: AppVariables },
    slug: string,
  ) => Promise<string | null>;
};
