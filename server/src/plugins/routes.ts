import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { reasonWithoutStatement } from "../db/query-failure";
import {
  type BrokerApp,
  type BrokerField,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  brokerSentence,
  type ComposioBroker,
  type Decides,
  isFieldScheme,
  type SchemeKind,
  schemeKind,
} from "./broker";
import { CATALOGUE, catalogueEntry } from "./catalogue";
import { toolkitOf, vendorSentence } from "./composio";
import {
  authorizationUrlFor,
  type ConnectOrigin,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  sealConnectState,
} from "./oauth";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  deploymentFaultSentence,
  isDeploymentFault,
  type OAuthClient,
  type PluginKind,
  PluginRefusedError,
  type PluginStore,
} from "./store";

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
function brokerRefusal(
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
const DIRECTORY_UNAVAILABLE =
  "Composio would not answer with its app directory, and said nothing about why. Check that COMPOSIO_API_KEY is this project's key, and check Composio's status if it persists.";

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
  connect?: {
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
  },
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

  /** Everything the Plugins page draws: the catalogue, what is added, and the skills. */
  routes.get("/", requireUser, async (context) =>
    context.json({
      catalogue: CATALOGUE.map((entry) => ({
        key: entry.key,
        title: entry.title,
        vendor: entry.vendor,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        /*
         * The kind, not the whole thing. The page needs to know what to ask an administrator for;
         * it has no use for the vendor's OAuth addresses, and a URL this deployment sends an
         * authorization code to is not improved by also existing in every browser that opens the
         * Plugins page.
         */
        auth: entry.auth.kind,
        perInstance: entry.host === null,
      })),
      /*
       * Whether a Bot with no credential of its own can still call a tool back.
       *
       * The grant switch decides whether a tool is offered to a model; this decides whether any
       * call it makes can be authenticated at all. They are different questions and the screen used
       * to answer only the first, so a grant could read "May call this tool" on a deployment where
       * every call was refused before it reached the boundary.
       */
      botsMayCallBack: connect?.botsMayCallBack === true,
      /*
       * Whether this deployment has a broker at all, so the page knows whether brokered apps are
       * on offer.
       *
       * A boolean about configuration, never the key. The API key that builds the broker is a
       * deployment credential and the Plugins page is reachable by any signed-in person; what the
       * screen needs is whether to draw the app directory, which is a yes or a no.
       */
      composioConfigured: Boolean(composio),
      servers: await store.listServers(),
      // Scoped: the deployment's skills plus this person's own. An administrator sees them all.
      skills: await store.listSkills(skillActor(context)),
      /*
       * What an administrator has to register with the vendor, character for character.
       *
       * Served rather than assembled in the browser, so what is displayed is exactly what the
       * callback will present. A mismatch here fails at the vendor with a message that does not name
       * us, which is a bad afternoon for whoever is setting it up.
       *
       * Null means this deployment has no public URL, so it cannot complete a consent flow at all.
       */
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    }),
  );

  /** Add a curated server. The URL comes from the catalogue, never from the request. */
  routes.post("/servers", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      key?: string;
      instanceHost?: string;
      credentialId?: string;
    } | null;
    if (!body?.key) {
      return context.json({ error: "A catalogue key is required." }, 400);
    }

    try {
      const server = await store.addServer({
        key: body.key,
        instanceHost: body.instanceHost,
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      // A refused credential is the administrator's mistake to correct, so it comes back as a
      // refusal with its reason rather than as a 500 the way an unmapped throw would.
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      /*
       * The same mapping the refresh route makes, on the routes that call the same method.
       *
       * CRITERION. Every admin route whose store call can reach a fault on the
       * `isDeploymentFault` shelf answers with the sentence rather than leaving it to the default
       * handler.
       *
       * REASON. Adding a server REFRESHES it before answering — deliberately, so a bad credential
       * is reported now rather than the first time a Bot uses it — so every fault `refreshTools`
       * raises arrives here too, and a vendor listing one action twice or a query of ours failing
       * is exactly that. Mapped on one route and not on its siblings, the same fault is a named
       * sentence or "That did not work" depending on which button was pressed, which is the shape
       * that made this class hard to see the first time.
       */
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Add a server by URL.
   *
   * Its own endpoint rather than a flag on the one above, so that "an administrator pointed this
   * deployment at an address of their own" is a distinct act in the code, in the audit trail and in
   * anything that reads either.
   */
  routes.post("/servers/custom", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      id?: string;
      title?: string;
      url?: string;
      credentialId?: string;
    } | null;
    if (!body?.id?.trim() || !body?.title?.trim() || !body?.url?.trim()) {
      return context.json(
        { error: "A name, a title and a URL are required." },
        400,
      );
    }

    try {
      const server = await store.addCustomServer({
        id: body.id.trim(),
        title: body.title.trim(),
        url: body.url.trim(),
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // As on the curated add above, and for the same reason: this path refreshes before it
      // answers.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Register this deployment's OAuth client for a server reached as the person asking.
   *
   * Its own endpoint rather than a field on `POST /servers`, because it is a separate act with a
   * separate lifetime: a client is rotated without the server being re-added, and re-adding a server
   * should not require re-typing a client. An administrator's, like everything else that decides what
   * a Bot can reach.
   */
  routes.post("/servers/:id/oauth-client", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      clientId?: string;
      clientSecret?: string;
    } | null;
    if (!body?.clientId?.trim() || !body.clientSecret?.trim()) {
      return context.json(
        { error: "A client id and a client secret are both required." },
        400,
      );
    }

    try {
      await store.registerOAuthClient({
        serverId: context.req.param("id"),
        client: {
          clientId: body.clientId.trim(),
          clientSecret: body.clientSecret.trim(),
        },
        by: actorEmail(context),
      });
      return context.json({ ok: true });
    } catch (error) {
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // Registering a client resolves the row first, so a row this deployment cannot say how to
      // reach refuses here as well.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Take a server away, and answer for a removal that did not finish.
   *
   * CRITERION. The same one the add routes above state, on the route that needed it most: every
   * refusal `removeServer` can raise comes back as a body naming what was left standing, rather
   * than reaching the framework's default handler.
   *
   * REASON. THIS MAPPED NOTHING AT ALL, and what it calls is the loudest method in the store.
   * `removeServer` withdraws every person's brokered account at Composio and drops this
   * deployment's auth configs BEFORE it deletes the row, deliberately — the argument is made
   * there, and it ends "WHICH MAKES THE FAILURE LOUD. Nothing is caught around the revokes". The
   * refusals it raises are written for exactly this reader: how many of this deployment's configs
   * went and how many are still standing, or a config row Composio described with no id and no
   * name. All of it reached Hono's default handler, which answers a bodyless 500, so an
   * administrator who had just half-withdrawn an app from everybody was told nothing whatever —
   * on the one act in this file whose half-done state somebody has to go and finish by hand.
   * `PluginInvariantError` out of `accessFor` arrived the same way, and it is the one that names
   * which of this deployment's own rows is wrong.
   *
   * THE SHELF FIRST, THEN THE BROKER, which is the order the enable route below pins and for its
   * reason: a contradiction between two of this deployment's columns is not Composio being down,
   * and answering it through the broker mapping would send an operator to check a key that is
   * fine. This route is `requireAdmin`, which is what makes showing that sentence here safe.
   *
   * AND THE GENERIC SENTENCE BLAMES NEITHER SIDE. Half of what this call path does is local — the
   * vault revokes, the trail writes, the deletes — and half of it is the broker, so a failure that
   * neither `brokerSentence` nor `vendorSentence` put words to is one where which half failed is
   * precisely what nobody said. What a reader needs is the button, and the store's own order is
   * what makes pressing it safe: nothing here is deleted until the withdrawals have been asked
   * for, so a second press asks only for what is left.
   */
  routes.delete("/servers/:id", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const serverId = context.req.param("id");
    try {
      await store.removeServer(serverId, actorEmail(context));
    } catch (error) {
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      /*
       * WHAT THE MAPPING COST, PUT BACK, exactly as the enable route below does it. An unhandled
       * throw was a bad answer and a good log: the administrator got nothing, but the stack was
       * printed where an operator could find it. Catching everything fixes the answer and would
       * silence that, and the failure that needs the log most is the one left here — neither a
       * refusal this deployment authored, which `brokerSentence` names, nor a sentence Composio
       * wrote, which `vendorSentence` reaches for. The row, because it is the app an operator is
       * about to be asked about, and the error read through {@link reasonWithoutStatement}, never
       * spread, logged as an object or reached into.
       *
       * AND THAT DOOR RATHER THAN `String(error)`, BECAUSE THE TWO SENTENCE TESTS ARE NOT A GUARD
       * AGAINST THIS. A `DrizzleQueryError` has neither a broker sentence nor a vendor one, so it
       * lands in exactly this branch — which is what removing a server raises when a delete fails
       * mid-way — and its own message is the statement plus every value bound to it.
       */
      if (brokerSentence(error) === null && vendorSentence(error) === null) {
        console.error(
          JSON.stringify({
            type: "mcp-server-not-removed",
            server: serverId,
            note: "Removing a server failed for a reason neither this deployment nor Composio put a sentence to. The administrator was answered 502 with the generic sentence, and the server row is still there.",
            error: reasonWithoutStatement(error),
          }),
        );
      }

      const refusal = brokerRefusal(
        error,
        "Removing this app did not finish, and neither this deployment nor Composio said why, so the app is still here rather than gone with grants of its own left live at the vendor. Press Remove again: every account is withdrawn at Composio before anything here is deleted, so repeating it is safe and asks only for what is left. Check this deployment's Composio key if it persists.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
    return context.json({ ok: true });
  });

  /** Ask a server what it offers now. Reported rather than thrown, so the page can say what broke. */
  routes.post("/servers/:id/refresh", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    try {
      const result = await store.refreshTools(
        context.req.param("id"),
        context.var.actor.id,
      );
      const servers = await store.listServers();
      return context.json({
        tools: result.tools,
        server: servers.find((server) => server.id === context.req.param("id")),
      });
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      /*
       * The one audience the sentence was written for, and the only route that may show it.
       *
       * CRITERION. A contradiction between this deployment's own columns comes back to an
       * administrator as itself: a body, naming the row and what to do about it.
       *
       * REASON. Unmapped, it reached the framework's default handler — a 500 with no JSON at all,
       * which the admin page reads as "That did not work", the fallback it uses when a response
       * carries no message. So the one refusal that names exactly which row is wrong and how to
       * correct it was the one an operator could not see, while the same sentence WAS reaching a
       * model on the tool-call path. This route is `requireAdmin`, which is what makes showing it
       * here safe and showing it anywhere else not.
       *
       * 409 rather than 500: nothing broke, and nothing about the request was malformed. Two rows
       * of ours disagree, and the request cannot be answered until one of them changes — which is
       * what the sentence tells the reader to go and do.
       */
      if (isDeploymentFault(error)) {
        // `deploymentFaultSentence` rather than `error.message`: the shelf now includes a query
        // this database refused, and that one's message is the statement and every value bound to
        // it. An administrator is entitled to the reason, not to the dump.
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * The broker's catalogue, as an administrator chooses an app out of it.
   *
   * THE SEARCH IS OURS, AND HAS TO BE. `@composio/core`'s toolkit listing forwards category,
   * managed_by, sort_by, cursor and limit, and takes no search term at all — a term handed to it is
   * dropped without a word, and what comes back is an unfiltered first page that looks exactly like
   * a result. So the whole directory is read and filtered in this process, over the three fields an
   * administrator would actually be typing at: the slug, the name and the description. A few
   * hundred rows is a list, not a query.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, not an empty list. An empty directory and an absent one
   * are different facts: the first says Composio has nothing to offer, the second says nobody was
   * asked. Answered as `{ apps: [] }`, a deployment with no key draws "no apps available" over a
   * remedy that is one environment variable long, which is why
   * {@link BrokerUnconfiguredError}'s own message is what is sent rather than a sentence written
   * here.
   *
   * `enabled` comes off `toolkitOf(url)` and never off the row's id. The url is where the
   * transport reads which app a call is against, so it is the only reading that decides anything;
   * the id names the row — `composio-linear` — and reading one as the other would quietly work
   * until somebody renamed a row. `serverUrls` hands over the urls and nothing else, which is that
   * property made structural: there is no id here to read by mistake.
   */
  routes.get("/composio/apps", requireUser, async (context) => {
    /*
     * INSIDE THE HANDLER, and the response returned. `requireAdmin` is a function that answers a
     * response, not Hono middleware: put in the middleware position it typechecks against Hono's
     * variadic signature, runs, and gates nothing at all, because nobody reads what it returned.
     */
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    if (!composio) {
      return context.json(
        { error: new BrokerUnconfiguredError().message },
        503,
      );
    }

    let directory: BrokerApp[];
    try {
      directory = await composio.broker.listApps();
    } catch (error) {
      // The vendor's own sentence where there is one, because "invalid api key" is the diagnosis
      // and a 500 is not. See {@link brokerRefusal} for what is kept out of the answer.
      const refusal = brokerRefusal(error, DIRECTORY_UNAVAILABLE);
      return context.json({ error: refusal.error }, refusal.status);
    }
    /*
     * AN APP THAT CANNOT BE CONNECTED IS NOT AN APP TO OFFER. Every kind but this one ends at a
     * person with a working account; `unsupported` ends at an administrator pressing Add and
     * meeting Composio's refusal, because the OAuth client it wants is one this deployment has
     * nowhere to hold. Hidden here rather than at the vendor: the filter is a fact about what this
     * deployment can drive, not about what Composio publishes.
     */
    const connectable = directory.filter(
      (candidate) => candidate.connection.kind !== "unsupported",
    );
    const term = (context.req.query("q") ?? "").trim().toLowerCase();
    const matched = term
      ? connectable.filter((app) =>
          [app.slug, app.name, app.description].some((field) =>
            field.toLowerCase().includes(term),
          ),
        )
      : connectable;

    /*
     * THE ONE CALL ON THIS ROUTE THAT IS NOT THE VENDOR'S, AND IT WAS THE ONE NOTHING ANSWERED FOR.
     *
     * CRITERION. The same one the add routes state: every admin route whose store call can reach a
     * fault on the `isDeploymentFault` shelf answers with the sentence rather than leaving it to
     * the default handler.
     *
     * REASON. The `try` above wraps `listApps` because that is where a wrong key shows itself, and
     * this read sat outside it with no mapping at all — so a query this database refused while
     * marking which apps are already enabled gave an administrator the framework's bodyless 500,
     * on the one screen where a Composio key has just been set. That is the reading most likely to
     * send somebody back to a key that is fine, over a fault Composio had no part in. The same 409
     * and the same sentence the sibling admin routes give the shelf; a failure that is not on it
     * still throws, which is what keeps the stack in the log.
     */
    let urls: string[];
    try {
      urls = await store.serverUrls();
    } catch (error) {
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }

    const enabled = new Set(
      urls
        .map((url) => toolkitOf(url))
        .filter((toolkit): toolkit is string => toolkit !== null),
    );
    return context.json({
      apps: matched.map((app) => ({ ...app, enabled: enabled.has(app.slug) })),
    });
  });

  /**
   * Enable one app of that catalogue, which is a third way for a server to arrive.
   *
   * THE SLUG VALIDATION IS THE WHOLE ROUTE. `addBrokeredApp` composes `composio://<slug>`, and that
   * url is what every future call for the app is resolved against — so a slug the directory never
   * answered with is a row pointing at an app that does not exist: added, grantable, enabled on a
   * Bot, and dead at the first call, with nothing on the page saying so. The live directory is what
   * it is checked against rather than a pattern, because the question is not whether the text is
   * well formed but whether Composio has such an app right now.
   *
   * The title comes off the directory entry too. The caller chose an app; they did not choose a
   * name for it.
   */
  routes.post("/composio/apps", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    if (!composio) {
      return context.json(
        { error: new BrokerUnconfiguredError().message },
        503,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      slug?: unknown;
    } | null;
    /*
     * ASKED WITH `typeof` RATHER THAN OFF THE ANNOTATION, which is the same hazard the skill routes
     * below spell out twice (`:2064`, and again at the grant route): the body is JSON, so the type
     * above is a wish. `{"slug":123}` made `(123).trim()` a `TypeError` thrown out of the handler —
     * and this statement sits outside every `try` here, so Hono's default handler answered a
     * bodyless 500 and the admin page fell back to "That app could not be added". Admin-gated, so
     * what it cost was an operator's diagnosis rather than anything they should not have had.
     *
     * A non-string is simply no slug, and the not-found refusal below already says the true thing
     * about that, so the narrowing answers with `undefined` rather than a second sentence.
     */
    const slug = typeof body?.slug === "string" ? body.slug.trim() : undefined;
    let directory: BrokerApp[] = [];
    if (slug) {
      try {
        directory = await composio.broker.listApps();
      } catch (error) {
        /*
         * The same failure the directory route answers, in the same words, because it is the same
         * call. Unhandled it was the worst 500 of the three: an administrator pressing Add on a
         * deployment whose key is wrong was told nothing at all, on the one screen where the key
         * had just been set.
         */
        const refusal = brokerRefusal(error, DIRECTORY_UNAVAILABLE);
        return context.json({ error: refusal.error }, refusal.status);
      }
    }
    const app = directory.find((candidate) => candidate.slug === slug);
    if (!app) {
      return context.json(
        {
          error: slug
            ? `${slug} is not an app Composio lists for this deployment.`
            : "An app is required.",
        },
        400,
      );
    }

    /*
     * AN APP THIS DEPLOYMENT CANNOT CONNECT IS NOT AN APP TO ADD, and the GET half above is not
     * enough on its own: it hides every `unsupported` app from the picker, so nobody presses Add on
     * one, but this route validates against the unfiltered `directory` — so a request that names
     * one by hand arrives here past that filter.
     *
     * WHAT IT WOULD REACH IS A STORE METHOD THAT RECORDS A MISLEADING ROW. `schemeFor` writes
     * `null` on `auth_scheme` for an unsupported connection, and a null there is read everywhere
     * else as "not a brokered row at all" — so the row enabling would write is one whose recorded
     * kind contradicts what it is.
     *
     * A SECOND GUARD RATHER THAN A REPLACEMENT: the adapter keeps its own refusal, and the two
     * catch different things. This one stops a CALLER OF THIS ROUTE reaching a store method that
     * would write that row — which is a fact about `addBrokeredApp`, and holds for whatever broker
     * is behind it, including one that would happily create the config. The adapter's stops ANY
     * caller at all — this route, a script, a future path — from reaching the vendor for an app
     * this deployment has nowhere to hold an OAuth client for. Neither subsumes the other, and the
     * store itself still has no guard, which is precisely why the cheap one here is worth having.
     *
     * The derivation's own `reason` is the sentence, because it names what is missing for this app
     * rather than for unsupported apps in general. 503 because this is a refusal this deployment
     * authored — the same status `brokerRefusal` gives an authored refusal raised a layer down, and
     * for the same reading: the brokered surface is unavailable for this app until somebody here
     * changes something, rather than unavailable because a third party is down. Not the 400 above,
     * which says the app does not exist; this one does exist, and this deployment cannot drive it.
     */
    if (app.connection.kind === "unsupported") {
      return context.json({ error: app.connection.reason }, 503);
    }

    try {
      const server = await store.addBrokeredApp({
        slug: app.slug,
        title: app.name,
        by: actorEmail(context),
        // Off the directory entry the administrator chose, never derived a second time here: a
        // second derivation is a second answer, which is the one thing `BrokerConnection` exists to
        // prevent. It decides what config the store creates at the vendor, and what the row records.
        connection: app.connection,
      });
      return context.json({ server }, 201);
    } catch (error) {
      // The same mapping the add routes above make, for the same reason: a refusal an
      // administrator can correct comes back as itself rather than as a 500.
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof PluginRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // And, as on those routes, enabling refreshes before it answers, so every fault
      // `refreshTools` raises arrives here as well. Its sentence blames nobody and names the row,
      // which is the honest answer whichever side of the insert the fault arrived on.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      /*
       * THE ONE REFUSAL THIS ROUTE CAN ONLY MEET AFTER THE ROW IS COMMITTED, and the only one its
       * three sibling add routes map and it did not.
       *
       * CRITERION. A failure thrown after `addBrokeredApp` has written and audited the row is not
       * reported as an app that was not enabled, and is not reported as Composio's doing.
       *
       * WHERE IT ARRIVES FROM. `addBrokeredApp` creates the auth config, inserts the row and files
       * its `configuration.changed` entry, and only THEN refreshes and reads the row back out of
       * `listServers` — raising this when it is not there, as `requireServer` does one call
       * deeper. Every one of those steps has already committed by then.
       *
       * WHAT IT USED TO BE ANSWERED WITH. Nothing caught it, so it fell through to the broker tail
       * below and an administrator was told "Slack could not be enabled, and Composio said nothing
       * about why. Try again, and check this deployment's Composio key if it persists." That is
       * wrong three times over: the app WAS enabled, Composio had no part in the step that failed,
       * and the one thing the reader now holds — a row on their Plugins page — went unmentioned
       * while they were sent to check a key that is fine.
       *
       * 409 RATHER THAN THE 400 ITS SIBLINGS GIVE THIS CLASS, because it is not the same fact
       * wearing the same class. On the add routes above, an unknown key is a caller naming a
       * server this deployment will not connect to, which is a malformed request. Here the row was
       * written and this deployment cannot see it: two of its own reads disagree, and the request
       * cannot be answered until one of them changes — the reading the refresh route's own 409
       * spells out. The message is written here rather than passed through, because
       * {@link CatalogueEntryUnknownError}'s own sentence is the one for the other case.
       */
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${app.name} was added, and then could not be read back out of this deployment's own servers — so the row and its trail entry stand, and what is on this page may be missing it. Reload the Plugins page: if ${app.name} is there it is enabled and there is nothing to redo, and if it is not, adding it again is safe.`,
          },
          409,
        );
      }
      /*
       * THE SAME MAPPING THE DIRECTORY READ ABOVE MAKES, FOR THE SAME REASON, and its absence here
       * is what left an administrator with nothing. Composio's own sentence — "Default auth config
       * not found for toolkit linear_mcp. Composio does not have managed credentials for this
       * toolkit." — travelled as an unhandled throw, so the route answered a bodyless 500 and the
       * browser fell back to its own "That app could not be added". Everything that explains the
       * failure existed; nothing carried it the last step.
       */
      /*
       * WHAT THE MAPPING COST, PUT BACK. A throw used to reach Hono's default handler, which is a
       * bad answer and a good log: the administrator got a bodyless 500, but the stack was printed
       * where an operator could find it. Catching everything fixed the answer and silenced the log,
       * and the failure that needs the log most is the one left here — not a refusal this
       * deployment authored, which `brokerSentence` names and `isDeploymentFault` already took one
       * branch above, and not a sentence Composio wrote, which `vendorSentence` reaches for. Both
       * null is a fault nobody has explained, most often a programmer error on this side, and it
       * would otherwise leave only the generic "Composio said nothing about why" in a browser
       * nobody is reading a console from.
       *
       * The same shape and the same restraint as the connection-not-recorded log below: the slug,
       * because it is the app an operator is about to be asked about; what the person was told, so
       * the console line and the support request can be matched up; and the error read through
       * {@link reasonWithoutStatement}, never spread, logged as an object or reached into. No key,
       * no vendor response, no request body, and no statement — the two sentence tests below do not
       * exclude a query failure, they are the branch one arrives in.
       *
       * AND THE NAME ON IT IS TRUE OF EVERY FAILURE THAT STILL REACHES IT. The two branches above
       * take the whole of what `addBrokeredApp` can raise once the row is committed — the shelf,
       * and the read-back that could not find it — so what is left arrives from the steps before
       * the insert, where nothing was written and the app really was not enabled. The generic
       * sentence below names Composio for the same reason: the one call in front of the insert is
       * `ensureAuthConfig`, which is a call to the vendor.
       */
      if (brokerSentence(error) === null && vendorSentence(error) === null) {
        console.error(
          JSON.stringify({
            type: "composio-app-not-enabled",
            slug: app.slug,
            note: "Enabling a brokered app failed for a reason neither this deployment nor Composio put a sentence to. The administrator was answered 502 with the generic sentence.",
            error: reasonWithoutStatement(error),
          }),
        );
      }

      const refusal = brokerRefusal(
        error,
        `${app.name} could not be enabled, and Composio said nothing about why. Try again, and check this deployment's Composio key if it persists.`,
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * Where a person's own connections are, and how to start a new one.
   *
   * Not admin-only, and that is the point: an administrator registers the connector once, and then
   * everybody connects their own account. Somebody can only ever see or start their own.
   */
  routes.get("/connections", requireUser, async (context) => {
    /*
     * BOTH TABLES, ONE LIST, because the person asking has one question.
     *
     * "Am I connected to this?" is the same question whether the grant is a refresh token in this
     * deployment's vault or an account Composio holds on our behalf. Which table a connection lives
     * in is a fact about how the vendor is reached — the transport, the credential, who keeps the
     * secret — and none of that is something a settings page should have to know in order to draw a
     * word beside a row. Answering out of `connectionsFor` alone left the brokered half invisible,
     * so the page could only either say "Not connected" over a live account or say nothing at all,
     * and it chose to say nothing.
     *
     * CONCATENATED WITHOUT REWRITING, because the fields a settings page draws from — the server
     * id, the scope, the date — line up across the two reads, and one row template can draw either
     * kind. What does not line up is what `brokeredConnectionsFor` adds — `verified`, `verifiedAt`,
     * `probe` and `checkable` — so the list that leaves here is not uniform. Those travel because a
     * brokered row is the only one with anything to re-check: this deployment holds no secret for
     * it, only a note that Composio said yes, and that note can drift when somebody ends the
     * connection in Composio's own dashboard. `probe` rides with the first two because the flag
     * cannot be read alone — three situations share one `verified: false`, and which action the
     * check actually SPENT is what separates them on a page that has done nothing but load.
     *
     * `probe` AND `checkable` ARE TWO ANSWERS AND NOT ONE SENT TWICE, and a caller that treats them
     * as interchangeable breaks the page in one of two opposite ways. `probe` is a record of the
     * check that was made; `checkable` is whether the app has anything to check with NOW. They
     * agreed while the first was derived, and an administrator's press of Refresh moved what the
     * app publishes without touching what the check spent — so the page accused a key nobody had
     * tried. Recording the first fixed that and deadlocked the other half: a key nothing was spent
     * on reads null for good, and the button that is the only way to ever spend one was gated on
     * that null. So the sentence is drawn off `probe` and the button off `checkable`; see
     * `brokeredConnectionsFor`, which sets both failures out in full. A held connection has no
     * equivalent question, so its rows carry none of these fields, and their absence is what tells
     * the two READS apart. It is not how a reader learns how an app connects: that is the app's
     * recorded `authScheme`, and a page asking this list instead would be deriving a second answer
     * to a question the row already carries.
     *
     * SORTED, so two requests answer in the same order. Each read is ordered by server id within
     * its own table, and concatenating two sorted lists is not a sorted list. Compared as plain
     * strings rather than by `localeCompare`, because the order only has to be the SAME one every
     * time, and a collation that varies with the deployment's locale is not that.
     */
    const [held, brokered] = await Promise.all([
      store.connectionsFor(context.var.actor.id),
      store.brokeredConnectionsFor(context.var.actor.id),
    ]);
    const connections = [...held, ...brokered].sort((left, right) => {
      if (left.serverId < right.serverId) return -1;
      return left.serverId > right.serverId ? 1 : 0;
    });

    return context.json({
      connections,
      // Shown to an administrator so they can register the client at the vendor with the exact value
      // this deployment will send. Null means the deployment has no public URL and cannot connect.
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    });
  });

  /**
   * Begin connecting one person's own account.
   *
   * Answers with a URL rather than redirecting, so the browser decides when to leave the page. The
   * state is minted here, from the session, and the person's identity never comes off the callback.
   */
  routes.post("/servers/:id/connect", requireUser, async (context) => {
    const serverId = context.req.param("id");

    /*
     * A BROKERED APP IS ANSWERED HERE AND GOES NO FURTHER DOWN THIS HANDLER.
     *
     * Everything below this branch belongs to the consent flow THIS deployment runs: a public URL
     * to build a redirect URI out of, a catalogue entry naming the vendor's authorization
     * endpoint, an OAuth client an administrator registered, a sealed state the callback reads
     * back. A brokered app has none of it. Composio holds the consent, so no authorization code
     * ever comes back to us, no refresh token is stored here, and no redirect URI of ours is
     * registered with anybody — there is nothing for those checks to be about.
     *
     * WHICH IS WHY THE ORDER IS THE WHOLE POINT AND NOT A TIDINESS. Falling through, a brokered
     * row met `catalogueEntry`, which has never heard of `composio-linear`, and the person
     * pressing Connect was told the app "is not connected as an individual person" — the exact
     * opposite of true about the one kind of row that is ONLY ever connected as an individual
     * person. On a deployment with no `OPENBOT_PUBLIC_URL` it failed one step earlier still,
     * refusing for want of a setting that has no bearing on a flow it does not enter.
     *
     * The app comes off the row's url via `toolkitOf` rather than off its id, for the reason the
     * directory route says: the url is where the transport reads which app a call is against, and
     * the id is a row name that happens to look similar.
     *
     * ONE ROW, BY ID. Every request to this route pays for this read, including the ones that fall
     * through to the OAuth flow below, because the branch cannot be taken until the row is in hand
     * — so what it costs has to be a lookup of three columns rather than the whole plugin surface.
     * `serverAddress` answering `undefined` is an id naming no row, which falls through exactly as
     * a missing row did when this was a `.find`.
     */
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    if (row && toolkit) {
      if (!composio) {
        return context.json(
          { error: new BrokerUnconfiguredError().message },
          503,
        );
      }

      /*
       * THE PERSON IS THE SESSION'S, HERE AND IN THE READ ABOVE IT.
       *
       * Nothing in this branch reads a user id out of the body or the query, and that is the
       * property rather than an implementation detail: the link minted below attaches an account
       * to whichever person it names, so a user id a caller could choose would let one POST hang
       * somebody else's mailbox off this deployment. It is the defect the prior art this design
       * follows shipped three separate times, and it is structural here — there is no line that
       * could break it.
       */
      const existing = await store.brokeredConnection({
        toolkit,
        userId: context.var.actor.id,
      });
      if (existing) {
        /*
         * Named with the step to take rather than only refused: a second link would attach a
         * second account behind a row that already says connected, and the way to a new one is
         * through the connection they have.
         *
         * THE APP'S TITLE, NOT THE ROW'S ID. `composio-linear` is this deployment's name for a
         * table row; "Linear" is the name of the thing the person connected and the only one of
         * the two they have ever seen on a screen. An internal key in a sentence addressed to a
         * person is both unhelpful and a small leak of how the rows are keyed.
         */
        return context.json(
          {
            error: `You already have an account connected to ${row.title}. Disconnect it first if you want to connect a different one.`,
          },
          409,
        );
      }

      /*
       * AN APP WHOSE SECRET THE PERSON HOLDS IS ANSWERED HERE AND NEVER SENT AT A CONSENT SCREEN.
       *
       * Most of Composio's catalogue connects this way rather than through a consent screen: the
       * person already holds an API key, so there is nothing to consent to, no url to mint and no
       * return leg to build — the press that opens a vendor page for a consent app has to answer
       * with a form instead, and the press after it carries what was typed into it. One route
       * serves all three arms because the browser asks the same question every time: connect me to
       * this app. The third is below: an app that needs no credential at all, which is answered
       * with the fact rather than with either flow.
       *
       * THE FORK IS THE SCHEME RECORDED ON THE ROW AT ENABLE TIME, which is what this deployment's
       * authorization config was actually created as — never a fresh catalogue read and never
       * anything the request said. {@link isFieldScheme} is asked rather than the string compared,
       * for the reason that function exists: one list, read by the guard and by the type, so the
       * schemes admitted here cannot come apart from the ones the broker's signature takes.
       *
       * AFTER THE ONE-ACCOUNT GUARD RATHER THAN BESIDE IT, and the order is a decision. Somebody
       * who already has an account attached has no business in front of a form: drawing one invites
       * them to type a key that would be refused once they had entered it, and even the first press
       * would spend a call at Composio on behalf of a request that is going to be refused anyway.
       * The refusal above names the step to take, and it is the same step for every kind of app.
       *
       * THE PERSON IS STILL THE SESSION'S, as everywhere else in this branch. Nothing below reads
       * a user id out of the body — and nothing below logs the body either, which matters more
       * here than anywhere else in this file: it is the one request this deployment handles that
       * carries somebody's own credential.
       */
      const authScheme = row.authScheme;

      /**
       * WHAT THIS FORK ANSWERS FOR EACH KIND OF APP, AND EVERY ARM IS REACHED BY DECIDING.
       *
       * Type-only and erased; see {@link Decides} in `./broker`. A fourth {@link SchemeKind} fails
       * `tsc` here by name, which is what this roster is for: the fork below reads a three-member
       * vocabulary with a chain of `if`s, and an `if` chain has no opinion about the answers it was
       * not written for.
       *
       * CRITERION. Every arm below is entered because {@link schemeKind} said so. No arm is the
       * fall-through of the others.
       *
       * REASON. This file used to import {@link isFieldScheme} and not `schemeKind`, and compare one
       * raw literal beside it — so the fork was two tests and a fall-through, and the fall-through
       * was the consent arm. A scheme this deployment cannot read — a null, or a literal nothing
       * here writes, which the row that ANSWERS for an app is free to carry because
       * `mcp_servers.url` has no unique index — therefore landed in the arm that mints an
       * authorization link at Composio for an app with no consent config behind it. That is a real
       * act performed at the vendor on behalf of an answer nobody decided, and its only possible end
       * is a link the person cannot complete. The three readers of this column in `./store` already
       * fail closed on that value; this one was the last that did not.
       */
      type _ConnectForkDecides = Decides<
        SchemeKind,
        {
          key: "answers with the form the app publishes, and connects what is typed into it";
          consent: "mints a link at Composio for the person to finish at the vendor's own screen";
          none: "refuses with the fact about the app — there is no account to connect and nothing is asked of Composio";
          unreadable: "refuses, and asks Composio nothing — it is not a consent app and there is no link to mint";
        }
      >;
      const kind = schemeKind(authScheme);

      /*
       * AN APP THAT NEEDS NO CREDENTIAL IS ANSWERED WITH WHAT IS TRUE OF IT, AND ASKS COMPOSIO
       * NOTHING.
       *
       * ITS OWN KIND, AND THE ONE THIS FORK USED TO HAVE NO ARM FOR. `NO_AUTH` is what
       * `connectionOf` resolves thirty-four of Composio's toolkits to and what `addBrokeredApp`
       * records on their rows. It is not a field scheme, so without this it fell through into the
       * consent arm below and met one of two dead ends: a 503 demanding `OPENBOT_APP_URL` for a
       * return leg this flow does not have, or `broker.authorize` — which can only fail, because
       * `ensureAuthConfig` deliberately creates NO authorization config for a no-auth app, Composio
       * having refused to hold one. The sentence that failure produces tells the person to remove
       * the app and add it again, and adding it again writes the identical row and fails
       * identically. That is one of the five connection kinds broken end to end, in the arm reached
       * by elimination rather than by decision.
       *
       * ASKED OF {@link schemeKind} RATHER THAN COMPARED AS A STRING, which is the second half of
       * that fix and arrived later than the first. The literal comparison here was right about the
       * app and silent about the vocabulary: `schemeKind` went on calling `NO_AUTH` a CONSENT
       * scheme, so this route and the per-person gate disagreed with the classifier — and with the
       * one consumer that did ask it, which wrote a `verified: true` connection row on every page
       * load for exactly the apps this branch refuses to make one for. `none` is now its own member
       * and this reads it.
       *
       * REFUSED RATHER THAN ANSWERED `connected`, AND THE DIFFERENCE IS A ROW. `composio_connections`
       * is the whole of the permission for a brokered call, and every row in it means one thing: this
       * person granted this deployment access to their account at this app. There is no account here
       * and there is no consent, so nothing may be written — which is exactly what
       * the store's own `connectionTokenFor` already acts on, letting a `NO_AUTH` call through with
       * no connection row at all rather than looking for one. A 200 claiming a connection would put
       * this app in front of every reader of that table — offboarding, the trail, the Disconnect
       * button — as an account somebody has to end.
       *
       * AND THE SENTENCE NAMES NO REMEDY, BECAUSE NOTHING IS WRONG. It says what the app is and that
       * its tools already work, which is the whole of what the person can act on. 400 for the reason
       * the OAuth branch below gives a row that is not connected as an individual person one: the act
       * does not apply to this kind of row.
       *
       * THE APP'S TITLE, NOT THE ROW'S ID, for the reason the one-account refusal above says it:
       * `composio-hackernews` is how this deployment keys a table and "Hacker News" is the name of
       * the thing on the screen.
       */
      if (kind === "none") {
        return context.json(
          {
            error: `${row.title} needs no account, so there is nothing to connect. A Bot granted its tools can use it as it is.`,
          },
          400,
        );
      }

      if (isFieldScheme(authScheme)) {
        /*
         * A SUBMISSION IS AN OBJECT OF VALUES, AND ANYTHING ELSE IS THE FIRST PRESS. The browser
         * sends no body at all when it is asking what the app wants, so an absent, empty or
         * unparseable one is that question rather than a malformed answer to it, and the worst a
         * caller gets for sending something stranger is the form back.
         */
        const body = (await context.req.json().catch(() => null)) as {
          values?: unknown;
        } | null;
        const submitted =
          typeof body?.values === "object" &&
          body.values !== null &&
          !Array.isArray(body.values)
            ? (body.values as Record<string, unknown>)
            : null;

        /*
         * ASKED OF THE VENDOR ON BOTH PRESSES, because it is the answer to both questions. On the
         * first it is the form itself; on the second it is the list the submission is checked
         * against, and reading it from anywhere else — a cached copy, the fields the form was drawn
         * from — would be checking a body against what the app used to ask for.
         */
        let published: BrokerField[];
        try {
          published = await composio.broker.connectionFields({
            toolkit,
            authScheme,
          });
        } catch (error) {
          const refusal = brokerRefusal(
            error,
            `Composio would not say what ${row.title} asks for, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
          );
          return context.json({ error: refusal.error }, refusal.status);
        }

        if (submitted === null) return context.json({ fields: published });

        /*
         * AN APP WITH NO BOXES CANNOT BE CONNECTED BY SOMEBODY TYPING, WHICH IS THE ONLY WAY THIS
         * BRANCH CONNECTS ANYBODY.
         *
         * {@link isFieldScheme} admits exactly the schemes whose secret a PERSON holds, so an
         * empty published list is not a short form — it is a form with nowhere to put the one
         * thing the scheme is for. Every check below passes such a submission for want of anything
         * to check, and what it makes is an account Composio marks `ACTIVE` because Composio does
         * not grade what it is handed. An app with no probeable action then has that row written
         * and drawn as connected on every screen here.
         *
         * ON THE SUBMISSION AND NOT ON THE PRESS ABOVE IT. The empty list is a true answer to
         * "what does this app ask for" — {@link ComposioBroker.connectionFields} says so, and
         * distinguishes it there from the scheme the app no longer publishes at all, which refuses.
         * What is false is the account the next press would make, so that is the press that is
         * refused.
         *
         * THE REMEDY IS AN ADMINISTRATOR'S, because nothing the person pressing Connect can do
         * changes what the app publishes or which scheme this deployment recorded for it.
         */
        if (published.length === 0) {
          return context.json(
            {
              error: `${row.title} publishes no boxes to fill in, so there is nothing you could type that would reach it and no account was made. An administrator has to look at how ${row.title} is set up at Composio; removing it on the Plugins page and adding it again is what records the way Composio connects it now.`,
            },
            400,
          );
        }

        /*
         * AND AN APP THAT PUBLISHES BOXES BUT REQUIRES NONE OF THEM IS THE SAME ACCOUNT WITH A FORM
         * IN FRONT OF IT.
         *
         * THE GUARD BELOW READS `required` ON THE NAMES THAT ARRIVED; THIS ONE READS THE LIST. A
         * published list with no required field in it leaves that guard nothing to be about, so
         * `{"values":{}}` passes it vacuously — and so does a box holding spaces, and so does the
         * default the form seeded itself from. What each of the three makes is an account carrying
         * no credential, which Composio answers `ACTIVE` for because it does not grade what it is
         * handed, and which an app with no probeable action leaves recorded and drawn as connected:
         * the very end state the required guard exists to prevent, reached down the one path that
         * guard cannot see.
         *
         * THE CLAIM THIS RESTS ON, STATED RATHER THAN ASSUMED: EVERY FIELD SCHEME IN COMPOSIO'S
         * CATALOGUE PUBLISHES AT LEAST ONE REQUIRED FIELD, BECAUSE A FIELD SCHEME IS COMPOSIO'S OWN
         * STATEMENT THAT THE PERSON HOLDS A CREDENTIAL. What makes it a claim about the catalogue
         * rather than a guess is that "this app needs nothing" already has its own name there:
         * `NO_AUTH` sits beside `API_KEY`, `BASIC`, `BEARER_TOKEN` and `BASIC_WITH_JWT` in the
         * vendor's own scheme enum (`@composio/core` 0.18.1, `src/types/authConfigs.types.ts:9-24`),
         * and this route answers it in its own branch a few lines above — so an app that reached
         * HERE has told Composio it needs SOMETHING, and a field list requiring nothing is not that
         * app saying it needs nothing after all.
         *
         * AND THE SDK SAYS WHAT THE SOMETHING IS, PER SCHEME. `connectedAccountAuthStates.types.ts`
         * declares the shape of an ACTIVE account one scheme at a time: `BASIC` and `BASIC_WITH_JWT`
         * require `username` and `password`, `BEARER_TOKEN` requires `token`, and `NO_AUTH` requires
         * nothing at all — an ACTIVE no-auth account is the base row and no credential beside it.
         * `API_KEY` is the one that marks `api_key` and `generic_api_key` optional, and it does so
         * because the NAME of the box varies across the catalogue and both spellings occur in it,
         * not because an API_KEY account may hold no key: the same declaration keeps a `catchall`
         * for the third spelling. Three of the four field schemes therefore say in the vendor's own
         * types that an account of theirs carries a credential, and the fourth says which credential
         * it cannot name.
         *
         * WHAT WAS NOT DONE, AND IT IS THE HONEST LIMIT OF THE CLAIM: the live catalogue was not
         * enumerated. There is no network and no Composio key on this path, so "no toolkit publishes
         * a field scheme with an empty required list" is ARGUED from the vendor's own package rather
         * than counted across its apps. The guard is written to fail in the safe direction for that
         * reason. If such an app does exist, it becomes an app this deployment will not connect and
         * SAYS SO, with a remedy addressed to the one person who could change it — which is the
         * direction the empty-list guard directly above already chose, and the opposite of the
         * silent credential-less account that is the alternative.
         *
         * THE STATE UNDER THIS GUARD IS ONE STATE AND NOT TWO, WHICH IS WHAT MAKES IT DECIDABLE AT
         * ALL. "An app whose required flags we could not read" used to be indistinguishable from
         * "an app that requires nothing", and it is no longer: {@link ComposioBroker.connectionFields}
         * reads each flag through `flagOf`, which answers the caller's default for an ABSENT flag
         * and refuses one that is PRESENT and not a boolean. So a list arriving here with every
         * `required` false is the vendor's own no on every row — never a shape this deployment
         * failed to read, because that shape never gets past the adapter.
         *
         * ON THE APP AND NOT ON THE SUBMISSION, AND THE SEEDED DEFAULT IS WHY. A guard that demanded
         * one non-blank value would be satisfied by the form's own work: the form draws each box
         * holding the default the app published and posts every published name back whether or not
         * anybody touched it, so a person who types nothing at an app publishing an optional
         * `base_url` submits that default — non-blank, unchosen, and a credential in no sense. The
         * thing that is false here is the app's field list, so the app is what is refused.
         *
         * ON THE SUBMISSION AND NOT ON THE PRESS ABOVE IT, for the empty-list guard's reason: the
         * list is a true answer to "what does this app ask for", and what is false is the account
         * the next press would make.
         *
         * THE SENTENCE NAMES THE BOXES THE APP DOES PUBLISH AND NO VALUE OF ANY KIND. These names
         * are the VENDOR's, read off the list just fetched rather than off the request, and they are
         * the whole of what an administrator needs to see what the app is publishing now. Nothing
         * submitted appears — not even a value that merely matches a published default, because on
         * this request that value is the caller's text rather than the vendor's.
         */
        if (published.every((field) => !field.required)) {
          const optional = published.map((field) => field.name).join(", ");
          return context.json(
            {
              error: `${row.title} publishes no box it says has to be filled in — only ${optional} — so nothing you could type would be a credential it insists on, and no account was made. An app that genuinely needs none is one Composio publishes as needing no authentication, and ${row.title} is recorded here as an app whose secret you type. An administrator has to look at how ${row.title} is set up at Composio; removing it on the Plugins page and adding it again is what records the way Composio connects it now.`,
            },
            400,
          );
        }

        /*
         * WHAT THE APP PUBLISHED, AND A NAME IT DID NOT IS REFUSED RATHER THAN QUIETLY DROPPED.
         *
         * ONE GUARD, THREE HOLES. What is submitted is spread into the field object the adapter
         * hands Composio, beside the literal `status: "ACTIVE"` that call sets — so an unfiltered
         * body lets a caller write over it. Anything else invented travels to the vendor
         * unexamined. And a field this deployment recorded that the app has stopped publishing
         * shows up here, at the request, rather than as a connection made without the value nobody
         * was asked for and a first tool call that discovers it.
         *
         * REFUSED, BECAUSE A PERSON CANNOT TYPE A NAME THE FORM DID NOT DRAW. The form is drawn
         * from this same list a moment earlier, so every name in an ordinary submission is one of
         * these; a name that is not leaves exactly two readings, and dropping it silently is the
         * wrong answer to both. If the app's published fields have moved, the person is holding a
         * stale form and the honest thing is to send them back for the current one — connecting
         * them with the part that still matches makes a credential-less account that every screen
         * here draws as connected. And if it is a caller reaching past the form on purpose,
         * "connected" is the one answer they must not get for a request this deployment edited
         * behind their back. Pressing Connect again costs a person one press and redraws the form
         * from what the app asks for now.
         *
         * THE VALUES ARE BUILT FROM THE NAMES THAT PASSED rather than the request object forwarded
         * once the check is done, so what reaches the store is the published subset by
         * construction and not on the strength of the loop above having run.
         *
         * A VALUE THAT IS NOT TEXT IS THE SAME REFUSAL. The store's signature promises strings, and
         * a number or an object under a published name is a lie told to that signature that reaches
         * Composio as whatever JSON makes of it.
         *
         * AND THE BAG HOLDS ONLY WHAT WAS PUT IN IT, WHICH `{}` DOES NOT. Every name here is the
         * VENDOR's — chosen by whoever publishes the app at Composio and never by this deployment —
         * and a plain object literal answers for names nobody submitted: `values.constructor` and
         * `values.toString` come back as functions off `Object.prototype`, so the required guard
         * below calls `.trim()` on a function and answers a person who typed nothing wrong with a
         * 500. A prototype value that happened to be TEXT would be worse still, because that guard
         * would count a credential nobody supplied and connect the account anyway. The other
         * direction fails silently: `values["__proto__"] = "acme"` on a literal reaches the
         * prototype setter, which ignores a string, so a value somebody typed is dropped between
         * the check that admitted it and the store that was meant to receive it — an account made
         * at Composio without one of the values the app publishes, marked `ACTIVE` because Composio
         * does not grade what it is handed, and drawn as connected on every screen here.
         *
         * A NULL-PROTOTYPE BAG IS THE WHOLE FIX AND IT IS THE SAME ONE THE FORM USES. Nothing is
         * inherited, so a read answers `undefined` exactly when nobody submitted that name and a
         * write stores what it was given under whatever name it was given. `Object.keys` — which is
         * what the audit row is built from one layer down — reads the same either way, and the
         * names are all this object's contents may ever appear as.
         */
        const names = new Set(published.map((field) => field.name));
        const values: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(submitted)) {
          if (!names.has(name) || typeof value !== "string") {
            /*
             * THE SENTENCE CARRIES NOTHING THAT WAS SUBMITTED — not the value, which is somebody's
             * own credential and belongs in no message, and not the name either, which on this
             * request is the caller's own text rather than the vendor's. It names the app and the
             * press that fixes it, which is the whole of what the person needs.
             */
            return context.json(
              {
                error: `That is not the form ${row.title} publishes, so nothing was sent to Composio. Press Connect again to draw it from what the app asks for now, and fill in the boxes it shows; each one holds text.`,
              },
              400,
            );
          }
          values[name] = value;
        }

        /*
         * AND WHAT THE APP SAID IT CANNOT DO WITHOUT HAS TO BE THERE, WHICH THE LOOP ABOVE NEVER
         * ASKED. That loop checks every name that ARRIVED; `required` is a fact about a name that
         * did not. A body of `{"values":{}}` passes it vacuously — no name is unpublished, no value
         * is not text — and what that connects is an account carrying no credential at all, which
         * Composio accepts because it does not grade what it is handed and which an app with
         * nothing safe to probe leaves recorded and drawn as connected.
         *
         * `required` HAD ONE READER AND IT WAS THE BROWSER. It rode the field out to the form and
         * became an HTML attribute, which is a courtesy to somebody filling boxes in and no kind of
         * guard: this route is reachable without that form, and the form itself accepts a space.
         *
         * BLANK IS ABSENT, AND WHITESPACE IS BLANK. The person's claim is that they filled the box
         * in, and a box holding spaces is one they did not — no vendor reads a key made of
         * whitespace, so admitting it buys exactly the account this guard exists to refuse, with a
         * value in it that makes the state harder to read rather than easier. The JUDGEMENT is made
         * on the trimmed text; what travels is what was typed, because trimming somebody's
         * credential on its way out is editing it, and a key that really does carry padding is the
         * vendor's to reject in its own words.
         *
         * OPTIONAL BOXES ARE UNTOUCHED BY THIS, and the distinction is the whole of why it reads
         * `required` rather than counting values. The form seeds each box from the default the app
         * published and posts every published name back whether or not anybody touched it, so a
         * blank optional value is what an ordinary submission carries.
         *
         * THE SENTENCE NAMES THE FIELDS AND NOTHING ELSE. These names are the VENDOR's, read off
         * the list this deployment just fetched rather than off the request — which is what sets
         * them apart from the refusal above, where the offending name is the caller's own text —
         * and no value of any kind appears here, for the reason the whole of this branch is built
         * around: a submitted value is somebody's own credential and belongs in no message, no log
         * and no row.
         */
        const missing = published
          .filter(
            (field) => field.required && !(values[field.name] ?? "").trim(),
          )
          .map((field) => field.name);
        if (missing.length > 0) {
          return context.json(
            {
              error: `${row.title} cannot be connected without ${missing.join(", ")}, so nothing was sent to Composio. Fill in every box the form marks required — a box holding only spaces is an empty one — and press Connect again.`,
            },
            400,
          );
        }

        try {
          /*
           * THE STORE'S ANSWER, WHOLE. `connected`, `verified` and `probe` are three facts and not
           * one dressed up: a null probe with `verified: false` is an app that publishes nothing
           * safe to check a key against, and a named probe with the same flag is a key the vendor
           * rejected on an account this deployment could not take back. A route that forwarded the
           * boolean alone would leave the row to infer which of those two it was, and it would tell
           * the second person that nothing had ever been tried.
           */
          return context.json(
            await store.connectBrokeredWithFields({
              toolkit,
              userId: context.var.actor.id,
              values,
            }),
          );
        } catch (error) {
          /*
           * A REFUSAL THE STORE AUTHORED IS PASSED THROUGH AS ITSELF, BEFORE THE BROKER MAPPING.
           *
           * A mistyped key is the ordinary failure on this path — a token from the wrong workspace,
           * a key pasted with a newline — and the store's sentence for it already carries the
           * vendor's own words and the step to take. `brokerRefusal` cannot see that: a
           * {@link PluginRefusedError} is neither an authored broker refusal nor a vendor object,
           * so it would come back as "Composio said nothing about why", sending somebody whose key
           * was rejected to ask an administrator about this deployment's Composio key. 400 for the
           * reason the skills route gives its own refusal one: it is something the person who made
           * the request can fix, and the message says what to fix.
           */
          if (error instanceof PluginRefusedError) {
            return context.json({ error: error.message }, 400);
          }
          const refusal = brokerRefusal(
            error,
            `${row.title} could not be connected with what you entered, and Composio said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
          );
          return context.json({ error: refusal.error }, refusal.status);
        }
      }

      /*
       * A SCHEME THIS DEPLOYMENT CANNOT READ IS REFUSED, AND IS NOT WALKED INTO THE CONSENT FLOW.
       *
       * `unreadable` is a null column or a literal nothing here writes — which is an ordinary row
       * rather than a corrupt one: `mcp_servers.url` carries no unique index, so the row that
       * answers for an app is not always the row an enable wrote a scheme onto, and a row may have
       * been inserted by hand or restored from a deployment that knew other names. Reached by
       * elimination, it arrived at the arm below and minted an authorization link at Composio for an
       * app this deployment holds no consent config for — a call spent at the vendor, and a link
       * whose only possible end is the person failing to complete it at a screen that has nothing
       * to ask them.
       *
       * THE REMEDY IS AN ADMINISTRATOR'S, because nothing the person pressing Connect can do
       * changes which scheme this deployment recorded for the app. Re-adding it is what writes the
       * column again, which is the same remedy the field branch above names for its own two
       * unreadable-app states. 400 rather than 503: it is a fact about this one app's row and not
       * about the deployment's settings.
       */
      if (kind === "unreadable") {
        return context.json(
          {
            error: `This deployment cannot tell how ${row.title} connects, so nothing was sent to Composio and no account was made. An administrator has to remove it on the Plugins page and add it again, which records the way Composio connects it now.`,
          },
          400,
        );
      }

      /*
       * NO APP URL IS A REFUSAL, NOT A LINK WITH NO WAY BACK.
       *
       * The address below is where Composio sends this person once they have consented, and it has
       * to be absolute: the consent screen is on another company's origin, so a relative path
       * resolves against theirs. A deployment that cannot say where its own pages are cannot
       * produce one — and minting the link anyway would leave somebody stranded on Composio's
       * hosted page having just granted access, with no route back to the deployment that asked
       * for it and nothing here knowing it happened.
       *
       * The OAuth flow below refuses for its missing `OPENBOT_PUBLIC_URL` in these same terms and
       * for this same reason. `OPENBOT_APP_URL` is the setting here because the two addresses are
       * genuinely different: the API is one origin and the browser app is another, and it is a
       * page this person is coming back to rather than an endpoint.
       *
       * BELOW BOTH BRANCHES ABOVE AND NOT IN FRONT OF THEM, FOR THE REASON THIS BRANCH'S OWN HEADER
       * GIVES ONE GUARD EARLIER. Neither an app whose secret the person types nor one that needs no
       * credential at all mints a link or has a return leg, so this setting has no bearing on either
       * flow — and standing before the fork, this guard meant no key app and no no-auth app could be
       * connected on a deployment without `OPENBOT_APP_URL`, refused in the name of a remedy that
       * would not have helped. It stays after the one-account guard for
       * the reason that guard's own comment gives: somebody who already has an account attached is
       * told the step to take, rather than handed an operator's configuration complaint about a
       * link that was never going to be minted for them.
       */
      if (!connect?.appUrl) {
        return context.json(
          {
            error:
              "This deployment has no app URL configured, so Composio would have nowhere to send you back to. Set OPENBOT_APP_URL.",
          },
          503,
        );
      }

      /*
       * WHERE THE CONSENT COMES BACK TO, BUILT HERE AND NEVER READ OFF THE REQUEST.
       *
       * Composio sends the person to this address when they are done, so whoever chooses it
       * chooses where somebody lands holding a just-completed consent. A url taken from the body,
       * the query or a header would therefore be an open redirect with a consent screen in front
       * of it — the exact thing {@link ConnectOrigin} exists to stop on the OAuth flow below, and
       * it is narrowed here in the same way: the caller may name one of two PAGES, and the origin
       * underneath them is this deployment's configured app URL in both cases.
       *
       * Both pages confirm on load, which is what makes either of them a correct destination: the
       * return trip carries nothing signed, so arriving proves nothing, and the page asks Composio
       * whether the account is really attached before anything here says it is.
       */
      const returnTo: ConnectOrigin =
        context.req.query("returnTo") === "admin" ? "admin" : "settings";

      /*
       * THE URL IS A BEARER CAPABILITY. Whoever opens it attaches an account to this person's
       * connection, so it is answered to the browser that asked and to nothing else: not logged,
       * not audited, not put in an error body. A redirect url in a log line is somebody else's
       * mailbox for as long as it stays valid — which is why the failure below answers with the
       * vendor's sentence and never with what was being minted when it failed.
       */
      let redirectUrl: string;
      try {
        ({ redirectUrl } = await composio.broker.authorize({
          userId: context.var.actor.id,
          toolkit,
          /*
           * THE REFUSAL ABOVE CHECKS THAT A SETTING IS SET; THIS CHECKS THAT IT IS AN ADDRESS.
           * `appUrl` is an environment string — `OPENBOT_APP_URL`, or the first `TRUSTED_ORIGINS`
           * entry — and nothing between there and Composio has ever looked at it, so
           * `openbot.example.com` with the scheme left off builds a callback that is not a
           * callback. That failure lands after somebody has consented, on the vendor's page, where
           * this deployment cannot tell them anything; the guard moves it to before the link is
           * minted, where the sentence reaches an operator who can set the variable.
           */
          returnUrl: brokerReturnUrl(
            connectedAccountsUrlFor(connect.appUrl, { serverId }, returnTo),
          ),
        }));
      } catch (error) {
        const refusal = brokerRefusal(
          error,
          `Composio would not begin a connection to ${row.title}, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
      return context.json({ authorizationUrl: redirectUrl });
    }

    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.",
        },
        503,
      );
    }

    const entry = catalogueEntry(serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.json(
        { error: `${serverId} is not connected as an individual person.` },
        400,
      );
    }

    /*
     * A dynamic entry introduces the deployment itself on first use; a manual one still waits
     * for an administrator. Registration lives here, on the one handler that already refuses
     * without OPENBOT_PUBLIC_URL — the redirect URI it registers is guaranteed to exist.
     */
    /*
     * A vendor in the catalogue that nobody has added to this deployment reaches here, gets past
     * every check above — the entry is real — and then asks the store for a client it cannot have,
     * because there is no server row to hold one. `ensureOAuthClient` says so by throwing, and
     * unhandled that was a 500 on the one path where a person is trying to connect their account.
     *
     * The same 409 as a vendor whose client an administrator has not pasted in yet, because it is
     * the same situation: the person pressing Connect has no step to take, and an administrator has
     * one. The sentence names the step rather than the exception.
     */
    let client: OAuthClient | null;
    try {
      client =
        (await store.oauthClientFor(serverId)) ??
        (entry.auth.clientRegistration === "dynamic"
          ? await store.ensureOAuthClient(serverId, actorEmail(context))
          : null);
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${entry.title} has not been added to this deployment yet. An administrator has to add it first.`,
          },
          409,
        );
      }
      throw error;
    }
    if (!client) {
      if (entry.auth.clientRegistration === "dynamic") {
        return context.json(
          {
            error: `${entry.title} would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.`,
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} has no OAuth client registered yet. An administrator has to add one first.`,
        },
        409,
      );
    }

    /*
     * Where to come back to, as one of two names rather than a URL the caller chose.
     *
     * Read from the query and narrowed immediately, so an unrecognised value is the default rather
     * than something carried into a sealed state. See {@link ConnectOrigin}: a destination that could
     * name another origin is an open redirect with a consent screen in front of it.
     */
    const returnTo =
      context.req.query("returnTo") === "admin" ? "admin" : "settings";

    const verifier = createVerifier();
    return context.json({
      authorizationUrl: authorizationUrlFor({
        auth: entry.auth,
        clientId: client.clientId,
        redirectUri: redirectUriFor(connect.publicUrl),
        state: await sealConnectState(
          { userId: context.var.actor.id, serverId, verifier, returnTo },
          connect.encryptionKey,
        ),
        codeChallenge: challengeFor(verifier),
      }),
    });
  });

  /**
   * Which app one of the three routes below is about, or the refusal that ends it.
   *
   * Each of them acts on a brokered connection and on nothing else, so each asks the same two
   * questions in the same order and answers them in the same words. It is one function because the
   * sentence somebody reads when they aim any of those routes at an ordinary OAuth row should not
   * be able to drift into three sentences.
   *
   * THE APP COMES OFF THE ROW'S URL AND NEVER OFF ITS ID, for the reason the directory route and
   * the connect branch above both give: the url is where the transport reads which app a call is
   * against, and the id is a row name that happens to look similar.
   *
   * ONE ROW, BY ID, AND CONFIRM IS WHY. Both brokered account screens call that route from an
   * effect when they mount, so this read runs on every page load — and it used to be
   * `listServers`, which materialises every tool and every grant in the deployment to answer
   * whether one row is brokered.
   *
   * A ROW THAT IS NOT BROKERED IS REFUSED IN SO MANY WORDS. The id may well name a server this
   * deployment really has — what is wrong is that its connection does not live at Composio, and
   * there is nothing for either route to confirm or to end. `null` from `toolkitOf` also covers an
   * id naming no row at all, which is the same answer from the caller's side.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, as it is on the directory and on connect, and it is
   * {@link BrokerUnconfiguredError}'s own message rather than a sentence written here.
   *
   * The connect route's brokered branch does not come through this function, deliberately: a row
   * that is not brokered has an OAuth flow below it to fall through to, so refusing there would be
   * wrong.
   */
  const brokeredAppFor = async (
    serverId: string,
  ): Promise<
    | { toolkit: string; refusal?: undefined }
    | { toolkit?: undefined; refusal: { error: string; status: 400 | 503 } }
  > => {
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    if (!toolkit) {
      return {
        refusal: {
          error: "That app is not reached through a broker.",
          status: 400,
        },
      };
    }
    if (!composio) {
      return {
        refusal: { error: new BrokerUnconfiguredError().message, status: 503 },
      };
    }
    return { toolkit };
  };

  /**
   * Ask Composio whether this person's account is really attached, and write the answer down.
   *
   * THE ROUTE EXISTS SO THAT THE VENDOR IS ASKED. The return trip from a consent screen is an
   * ordinary redirect with nothing signed in it, so a browser landing back on the settings page
   * proves nothing: not that the flow finished, and not that it finished with the account a row
   * would go on to claim. Composio tells this deployment nothing by itself — there is no callback
   * of ours in that flow — so unless something asks, all that stands behind the gate every later
   * brokered call passes through is a guess about what a redirect meant.
   *
   * AND IT IS MEANT TO BE CALLED AGAIN, on any page load, which is the other half of why it is
   * here. The row is only a cache of the vendor's last answer, so it drifts by construction — an
   * account ended in Composio's own dashboard, a consent this deployment never saw finish — and
   * calling this heals it in whichever direction it went: written where the vendor says yes,
   * deleted where it says no. Repeating it files no trail rows and moves no timestamps; the store
   * is where that is settled.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED. An administrator adds the app once; confirming one's
   * own connection to it is not an administrative act.
   */
  routes.post(
    "/servers/:id/connection/confirm",
    requireUser,
    async (context) => {
      const resolved = await brokeredAppFor(context.req.param("id"));
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }

      /*
       * THE PERSON IS THE SESSION'S, AND THERE IS NO SECOND SOURCE FOR THEM. Nothing here reads a
       * user id out of the body or the query, and that is the property rather than an
       * implementation detail: a confirm writes the row every later brokered call is gated on, so
       * a caller who could name somebody else would be one POST away from recording a connection
       * under a person who never made one — or, the same defect turned around, from deleting the
       * row of a person the vendor answers no for.
       *
       * The store's answer is passed straight back rather than restated here. `connected` is what
       * Composio said, and a shape invented at this layer would be a second opinion about a fact
       * only the vendor holds.
       */
      try {
        return context.json(
          await store.confirmBrokeredConnection({
            toolkit: resolved.toolkit,
            userId: context.var.actor.id,
          }),
        );
      } catch (error) {
        /*
         * A BROKER THAT WOULD NOT ANSWER IS NOT A CONNECTION THAT IS ABSENT.
         *
         * This route is called on every page load, so the tempting answer to a failure is
         * `{ connected: false }` — and that would be this deployment inventing a fact only Composio
         * holds, drawing "Not connected" over a live account and, one step on, deleting the row
         * that says otherwise. The store deletes on a NO from the vendor, and a failure is not a
         * no. So the page is told the ask failed, and what it goes on showing is the last answer
         * Composio gave rather than a guess about this one.
         */
        const refusal = brokerRefusal(
          error,
          "Composio would not say whether this account is connected, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Try again, and ask an administrator to check this deployment's Composio key if it persists.",
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * Try this person's key against the app, because they pressed the button that asks.
   *
   * A BUTTON, AND NEVER A PAGE-LOAD EFFECT, which is the one thing a caller of this route has to
   * know. Composio never re-checks a key — it accepts one when it is typed and says nothing about it
   * again — so this is the only thing in the product that can correct a row whose key was rotated,
   * revoked or left to expire. That is also the argument somebody will make for calling it from an
   * effect on mount, and it is wrong: the call goes out to the app on the person's OWN account and
   * against their own rate limit at the vendor, so verifying on every render would spend somebody's
   * quota at Linear to redraw one word on a settings page. The confirm route above is the one that
   * runs on mount; it asks Composio about its own records and costs the person nothing.
   *
   * AND IT IS NOT A CONNECT. The store's argument is made there in full: the account already exists,
   * so nothing here creates one, nothing withdraws one when the key turns out to be bad — their
   * account stays, it is their key that is wrong — and nothing changes but the verification and its
   * date.
   *
   * A PROBE THAT RAN AND FAILED COMES BACK AS A FAILURE, never as a 200 saying `verified: false`.
   * That flag is also what an app publishing nothing safe to call produces, and the row drawing this
   * answer cannot tell the two apart — so an answer would quietly drop the Re-check button in
   * exactly the state somebody needs it, having just fixed their key, while telling them nothing had
   * ever been checked. The store raises with Composio's own sentence in it, and this passes that
   * through as a refusal the browser surfaces. The only `verified: false` that arrives as an answer
   * is the one carrying `probe: null`, which says there was nothing to check with.
   *
   * THE PERSON IS THE SESSION'S, as on the two routes around it and for the sharper reason this one
   * adds: a user id a caller could name would let one POST spend a stranger's rate limit at the
   * vendor and rewrite the verification on their row. Nothing here reads a user id out of the body
   * or the query.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED, for confirm's reason: this is somebody checking their
   * own account, not an administrator checking anybody's.
   */
  routes.post(
    "/servers/:id/connection/recheck",
    requireUser,
    async (context) => {
      const resolved = await brokeredAppFor(context.req.param("id"));
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }

      try {
        // The store's answer, whole. `verified` is the flag, `verifiedAt` is the date the row's
        // sentence is drawn from, and `probe` is what says a call was really made — three facts,
        // and a route that forwarded the boolean alone would leave the row to guess the other two.
        return context.json(
          await store.recheckBrokeredConnection({
            toolkit: resolved.toolkit,
            userId: context.var.actor.id,
          }),
        );
      } catch (error) {
        /*
         * A REFUSAL THE STORE AUTHORED IS PASSED THROUGH AS ITSELF, BEFORE THE BROKER MAPPING, for
         * the reason the connect route's field branch gives: a key the vendor rejected is the
         * ordinary failure on this path, and the store's sentence for it already carries Composio's
         * own words and the step to take. `brokerRefusal` cannot see that — a
         * {@link PluginRefusedError} is neither an authored broker refusal nor a vendor object — so
         * it would answer somebody whose key is wrong with "Composio said nothing about why" and
         * send them to an administrator about this deployment's key. 400 because it is theirs to
         * fix and the message says what to fix.
         */
        if (error instanceof PluginRefusedError) {
          return context.json({ error: error.message }, 400);
        }
        /*
         * And a failure this deployment cannot explain says what is on the screen instead of
         * guessing. Nothing was written on the way out of the store here, so the row still carries
         * the last answer anybody earned rather than a verdict invented by a call that failed.
         */
        const refusal = brokerRefusal(
          error,
          "Composio would not say whether this connection still works, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Press Re-check again, and ask an administrator to check this deployment's Composio key if it persists.",
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * End this person's own brokered account, at the vendor first and here after.
   *
   * The order is the store's and the argument for it is made there: the row is the only thing that
   * says which app this person connected, so a delete that ran before the revoke could leave a live
   * grant on somebody's mailbox that nothing here can reach. What comes back is what was asked for
   * — `vendorRevocationRequested` false is a grant that was already gone — and it is passed through
   * rather than rewritten, because telling those two apart is the whole value of the field.
   *
   * `reason` IS "self" BECAUSE OF WHO IS ASKING. The other word the store takes is
   * `person_removed`, which belongs to an administrator offboarding somebody from the People
   * screen. The trail tells the two acts apart by this word and by whether `by` and the owner
   * differ, and on this route they are the same person by construction.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED, for the reason confirm gives: this is somebody
   * ending their own account, not an administrator ending anybody's.
   */
  routes.delete("/servers/:id/connection", requireUser, async (context) => {
    const resolved = await brokeredAppFor(context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }

    /*
     * WHOSE ACCOUNT THIS IS COMES FROM THE SESSION, here as on confirm and for a sharper reason: a
     * user id a caller could name would be a DELETE that revokes somebody else's grant at the
     * vendor. It is read once, from `context.var.actor`, and used for both the owner and the actor
     * — nothing in the body or the query is looked at at all.
     */
    try {
      return context.json(
        await store.disconnectBrokered({
          toolkit: resolved.toolkit,
          userId: context.var.actor.id,
          by: context.var.actor.id,
          reason: "self",
        }),
      );
    } catch (error) {
      /*
       * REPEATING IT IS THE RECOVERY, AND THE SENTENCE SAYS SO RATHER THAN GUESSING HOW FAR IT GOT.
       *
       * The revoke runs before anything here is deleted, which is what makes a second press safe:
       * whatever this failed at, the state it leaves is access dead or access untouched, never
       * access live with nothing here able to reach it. Claiming "nothing was changed" would be a
       * guess — a delete that succeeded and an audit write that did not is the same throw — and the
       * one thing a person needs is the button to press, not this deployment's theory of where it
       * stopped.
       */
      const refusal = brokerRefusal(
        error,
        "Composio would not end this account, and gave no reason. Press Disconnect again: the revoke at Composio runs before anything here is deleted, so repeating it is safe and is the whole recovery. Ask an administrator to check this deployment's Composio key if it persists.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * Where the vendor sends somebody back.
   *
   * Deliberately not behind `requireUser`. The person arrives on a redirect from another company's
   * server, and whose connection this is comes from the sealed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's Google account to another person's row.
   *
   * Having no session is what makes the access check below necessary. Every other route asks the
   * question by being behind a guard; this one has to ask it out loud.
   *
   * Every failure ends the same way: back at Settings with a word about what happened, and nothing
   * written. There is no useful distinction here for the person between a forged state and an expired
   * one, and spelling out which is which tells anybody probing this endpoint how far they got.
   */
  routes.get("/oauth/callback", async (context) => {
    const failed = connectedAccountsUrlFor(connect?.appUrl, {
      failed: true,
    });
    if (!connect?.publicUrl) return context.redirect(failed);

    /*
     * EVERY WAY OUT OF THIS HANDLER IS A REDIRECT, AND THE `try` IS WHAT MAKES THAT TRUE.
     *
     * CRITERION. No request to this endpoint ends without a `Location`.
     *
     * REASON. The header above says every failure ends the same way, and that was true of
     * every failure this handler ASKED for and of none of the failures its questions could
     * raise. `personHasAccess` reaches the people store and `oauthClientFor` reaches the
     * vault, and either of them throwing put somebody who had just consented at another
     * company on a bodyless 500 with no `Location` at all — no page, no notice, nothing to
     * press, and a browser left on this API's origin, which locally serves no pages at all.
     * It is the exact answer this route exists to make impossible: `redeemAuthorizationCode`
     * guards its own `fetch` against it in as many words, and the vault write below was given
     * a `catch` for it — one call at a time, which is the shape that keeps leaving one out.
     *
     * SO IT IS THE WHOLE BODY RATHER THAN EACH CALL. A blanket `catch` is a promise about the
     * route; a per-call one is a promise about the calls somebody remembered. Nothing is
     * written before the vault, so a failure anywhere above it leaves the same nothing behind
     * as an unreadable state does, and the person is told the same sentence either way.
     *
     * THE PERSON LEARNS NOTHING NEW FROM IT, deliberately, for the reason the header gives:
     * there is no useful distinction here between a forged state and a store that would not
     * answer, and spelling out which is which tells anybody probing this endpoint how far they
     * got. The console is where the difference survives, and it carries the error stringified
     * and nothing else — not the state, which names a person, and not the code, which is one
     * redemption away from a refresh token.
     */
    try {
      const code = context.req.query("code");
      const state = await readConnectState(
        context.req.query("state") ?? "",
        connect.encryptionKey,
      );
      if (!code || !state) return context.redirect(failed);

      /*
       * Is the person in the state still somebody here?
       *
       * Asked here, before the code is redeemed and before anything is written, because a state is
       * good for ten minutes and access can end inside them. Removing somebody deny-lists their
       * address, deletes their sessions and retires the credentials they had already granted — and
       * none of that reaches a consent already in flight at the vendor. Without this, that consent
       * comes back and writes a fresh, live refresh token belonging to somebody who no longer has
       * access, which nothing downstream will ever revoke because nothing knows it was created.
       *
       * The same anonymous failure as an unreadable state. Whether an address is deny-listed is not a
       * fact this endpoint owes an unauthenticated caller.
       */
      if (!(await connect.personHasAccess(state.userId))) {
        return context.redirect(failed);
      }

      const entry = catalogueEntry(state.serverId);
      if (entry?.auth.kind !== "user-oauth") return context.redirect(failed);

      const client = await store.oauthClientFor(state.serverId);
      if (!client) return context.redirect(failed);

      const grant = await redeemAuthorizationCode({
        tokenUrl: entry.auth.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: redirectUriFor(connect.publicUrl),
        verifier: state.verifier,
      });
      if (!grant) return context.redirect(failed);

      /*
       * The last thing that can fail, answered the same way as everything before it.
       *
       * A vault that will not take the grant is this deployment's problem, not the person's, and they
       * have already done their part at the vendor. Unhandled, this threw past the handler and gave
       * them the bare 500 that every other failure on this route was written to avoid, on the one
       * path where they had most reason to think it had worked.
       *
       * Told, because unlike the refusals above this one is nobody's fault but ours, and the person's
       * sentence deliberately says nothing about which failure it was. The refresh token is not
       * logged: it is the one thing here worth stealing, and the row it belonged to was never written.
       */
      try {
        await store.recordConnection({
          serverId: state.serverId,
          userId: state.userId,
          refreshToken: grant.refreshToken,
          scope: grant.scope,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "oauth-connection-not-recorded",
            serverId: state.serverId,
            note: "A person consented and the grant could not be stored. They were sent back to Settings with a failure and will have to connect again.",
            /*
             * READ THROUGH {@link reasonWithoutStatement}, BECAUSE THE FAILURE THIS LINE EXISTS FOR
             * IS THE ONE WHOSE MESSAGE CARRIES THE REFRESH TOKEN.
             *
             * `recordConnection` runs `swapUserCredential` → `credentials.create/rotate`, whose
             * bound parameters include `encryptedValue: await encryptSecret(key, refreshToken)`.
             * drizzle wraps a driver failure as a `DrizzleQueryError` whose own message is
             * `Failed query: insert into "credentials" … params: …, <the envelope>, …`, so
             * `String(error)` here put the envelope on this deployment's stdout and into whatever
             * sink collects it — for a person who was correctly told nothing was saved. Two consent
             * callbacks for one `(serverId, userId)` landing together, or a statement timeout on
             * the insert, is all it takes.
             *
             * The helper answers the driver's own complaint instead — `duplicate key value violates
             * unique constraint`, `canceling statement due to statement timeout` — which is the
             * useful half and names nothing anybody sent.
             */
            error: reasonWithoutStatement(error),
          }),
        );
        return context.redirect(failed);
      }

      return context.redirect(
        connectedAccountsUrlFor(
          connect.appUrl,
          { serverId: state.serverId },
          // From the sealed state, so the destination is one this deployment chose, not the browser.
          state.returnTo,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "oauth-callback-failed",
          note: "A person came back from a consent screen and a check on this route raised instead of answering. They were sent back to Settings with a failure, nothing was written, and they will have to connect again.",
          // The outer catch of the branch above, so it stands over the same write and needs the
          // same door. See the note on `oauth-connection-not-recorded`.
          error: reasonWithoutStatement(error),
        }),
      );
      return context.redirect(failed);
    }
  });

  /**
   * Write a skill.
   *
   * Not admin-only. A skill is an instruction, not a capability: it can only ask a
   * Bot to use tools that Bot was already granted, and every one of those calls is still decided,
   * policy-checked and audited. Adding an MCP server is the opposite, and stays an administrator's.
   *
   * A person's skill is their own. `global` writes one for the whole deployment, which an
   * administrator may do and nobody else.
   */
  routes.post("/skills", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      slug?: unknown;
      title?: unknown;
      summary?: unknown;
      instructions?: unknown;
      global?: boolean;
      tools?: unknown;
    } | null;
    /*
     * The body is JSON, so the annotations are wishes: `{"slug":123}` passes a truthiness
     * check and `RegExp.test` then coerces it to `"123"`, and `{"summary":{}}` reaches the
     * store where the insert throws a 500. A slug, a title and instructions are non-empty
     * strings here, and a summary is absent or a string. Anything else is a 400 before
     * any refusal check, store write, or audit row.
     */
    if (
      typeof body?.slug !== "string" ||
      typeof body?.title !== "string" ||
      !body.title.trim() ||
      typeof body?.instructions !== "string" ||
      !body.instructions.trim()
    ) {
      return context.json(
        { error: "A slug, a title and instructions are required." },
        400,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(body.slug)) {
      return context.json(
        { error: "A slug is lower-case letters, numbers and hyphens." },
        400,
      );
    }
    if (body.summary !== undefined && typeof body.summary !== "string") {
      return context.json(
        { error: "A summary is text when it is present." },
        400,
      );
    }

    const actor = skillActor(context);
    if (body.global && !actor.isAdmin) {
      return context.json(
        { error: "Only an administrator writes a skill for the deployment." },
        403,
      );
    }

    // Editing an existing slug, which is what a repeated save is, needs the right to edit that
    // skill. Without this, saving over somebody else's name would silently take it.
    const refusal = await skillRefusal(context, body.slug);
    if (refusal) return context.json({ error: refusal }, 403);

    /*
     * Absent leaves the declarations alone, so a caller that predates this field does not silently
     * clear one. An array, including an empty one, says what the skill needs now.
     */
    if (body.tools !== undefined && !Array.isArray(body.tools)) {
      return context.json(
        { error: "Tools are a list of serverId/toolName references." },
        400,
      );
    }
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((ref): ref is string => typeof ref === "string")
      : undefined;

    try {
      await store.installSkill({
        slug: body.slug,
        title: body.title.trim(),
        summary: body.summary ?? "",
        instructions: body.instructions.trim(),
        ownerUserId: body.global ? null : actor.id,
        ...(tools === undefined ? {} : { tools }),
        by: actorEmail(context),
      });
    } catch (error) {
      // A ref naming no tool this deployment has seen. Answered rather than thrown, because it is
      // something the person writing the skill can fix and the message says what to fix.
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
    return context.json({ skills: await store.listSkills(actor) });
  });

  routes.delete("/skills/:slug", requireUser, async (context) => {
    const slug = context.req.param("slug");
    const refusal = await skillRefusal(context, slug);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.uninstallSkill(slug, actorEmail(context));
    return context.json({ ok: true });
  });

  /**
   * Grant and revoke, for both kinds, through one pair of endpoints.
   *
   * The store keeps one grant table because the question is the same either way; the API says the
   * same thing, so a reader is never left wondering whether skills are governed differently.
   */

  /**
   * The kinds of grant this API will act on.
   *
   * CHECKED AT RUNTIME, not only in the types. `kind` arrives in a JSON body, so a type annotation
   * on it is a comment: before this, anything at all could be written into the grant table through
   * the ordinary endpoint, and one kind that was never meant to be settable this way already could.
   */
  const GRANT_KINDS = new Set<PluginKind>(["mcp", "skill", "bot"]);
  const asGrantKind = (value: unknown): PluginKind | null =>
    typeof value === "string" && GRANT_KINDS.has(value as PluginKind)
      ? (value as PluginKind)
      : null;

  /**
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: PluginKind,
    ref: string,
    agentId: string,
    /**
     * Which way this is going, because they are not symmetric.
     *
     * TAKING SOMETHING AWAY IS ALWAYS ALLOWED. The checks below decide whether a grant should exist,
     * and applying them to a revoke turns every one of them into a trap: a `bot` grant made before
     * the grantee moved to its own endpoint — or before this check existed — could never be removed,
     * because the reason it is wrong is the same reason the revoke was refused. An administrator
     * looking at a dead row in the UI would have had no way to delete it.
     */
    intent: "grant" | "revoke",
  ): Promise<string | null> {
    const actor = skillActor(context);

    if (kind === "mcp") {
      return actor.isAdmin
        ? null
        : "An administrator decides which Bots may reach a tool.";
    }

    if (kind === "bot") {
      /*
       * THE ROLE IS CHECKED BEFORE ANYTHING IS LOOKED UP, and that ordering is the point.
       *
       * One Bot reaching another lets it spend that Bot's model calls, wake its computer and reach
       * whatever it may reach, so it is an administrator's decision rather than something somebody
       * attaches to a coworker they own. But this route only requires a signed-in user, so every
       * refusal below is readable by anybody: checking whether the Bot exists, and whether it runs
       * here, before this line handed out three distinguishable answers and turned a 403 into an
       * oracle for other people's private Bots. `handoff.ts` in this same feature collapses exactly
       * this, deliberately, and this had it backwards.
       */
      if (!actor.isAdmin) {
        return "An administrator decides which Bots may hand work to another Bot.";
      }
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, from both ends.
       *
       * The GRANTEE has to run here, because handing work on is a tool this deployment executes: a
       * Bot at an endpoint runs its own loop and is handed descriptions of what it may call back
       * for, and there is no callback path that would execute a hop.
       *
       * The TARGET only has to exist. Being handed work is not the same as being able to hand it on,
       * so a target at its own endpoint is perfectly ordinary — but `ref` is bare text with no
       * foreign key, so a typo stored happily and every hop then refused as not-granted.
       */
      /*
       * A Bot cannot be granted itself. The desk refuses a self-hop outright — "a Bot cannot hand
       * work to itself" — so the row is dead the moment it is written, and reads as configured.
       */
      if (ref === agentId) {
        return "A Bot cannot be granted itself to hand work to.";
      }
      const runsHere = await store.agentRunsHere(agentId);
      if (runsHere === undefined) return "There is no such Bot.";
      if (!runsHere) {
        return `${agentId} runs at its own endpoint, so this deployment cannot offer it a tool for handing work on. Only a Bot that runs here can be given one.`;
      }
      if (!(await store.agentIsRegistered(ref))) {
        return `There is no Bot called ${ref} to hand work to.`;
      }
      return null;
    }

    if (actor.isAdmin) return null;

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to this deployment. An administrator decides which Bots use it.`
        : `${ref} is somebody else's skill.`;
    }

    const botOwner = await store.agentOwner(agentId);
    if (botOwner === undefined) return "There is no such Bot.";
    if (botOwner !== actor.id) {
      // Including the shared Bots this deployment publishes, which have no owner at all: a skill
      // one person wrote would otherwise change how a Bot answers everybody.
      return "You can only put your own skills on Bots you own.";
    }
    return null;
  }

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      ref?: string;
      agentId?: string;
    } | null;
    const kind = asGrantKind(body?.kind);
    /*
     * The body is JSON, so the annotation is a wish: `{"ref":123,"agentId":[]}` passes a
     * truthiness check and then reaches the store, where Drizzle compares a text column against
     * a number and the request answers 500. A ref and a Bot id are non-empty strings here.
     */
    if (
      !kind ||
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      kind,
      body.ref,
      body.agentId,
      "grant",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.grant(kind, body.ref, body.agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = asGrantKind(context.req.query("kind"));
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    /*
     * Query params are always strings, so truthiness is not enough: `"   "` is truthy and used
     * to pass this check, delete zero rows by exact match, still write a `plugin_revoked` audit
     * row naming whitespace, and answer `ok:true`. The POST twin already requires non-empty
     * strings; this requires the same and acts on the trimmed values.
     */
    if (
      !kind ||
      typeof ref !== "string" ||
      !ref.trim() ||
      typeof agentId !== "string" ||
      !agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const trimmedRef = ref.trim();
    const trimmedAgentId = agentId.trim();
    const refusal = await enablementRefusal(
      context,
      kind,
      trimmedRef,
      trimmedAgentId,
      "revoke",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, trimmedRef, trimmedAgentId, actorEmail(context));
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  routes.get("/for/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    // A grant list is a fact about the Bot it belongs to. Left open it says which tools somebody
    // else's private coworker has been given.
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    return context.json(await store.listForAgent(agentId));
  });

  /**
   * Call a tool, as a Bot.
   *
   * The grant, the policy and the audit row all happen inside the store, so this endpoint cannot
   * accidentally satisfy one of them and skip another. A refusal comes back as 403 with the reason
   * the model and the person are both shown, which is the same sentence written to the trail.
   *
   * NOTHING IN THIS REPOSITORY CALLS IT. It is what the browser used to post to when a Bot's tool
   * loop ran client-side; that loop moved to the server, and the client helper for this went with it.
   * Kept rather than removed, because #37 hardened it with `canUseBot` after that move — so removing
   * it belongs in a change that says so, not in a merge resolution.
   */
  routes.post("/call", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      ref?: string;
      args?: Record<string, unknown>;
      agentId?: string;
    } | null;
    // Same shape lie as `/grants` above: JSON numbers, objects and arrays are truthy, so they
    // must be refused here rather than inside `canUseBot` or the tool call.
    if (
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json({ error: "A tool and a Bot are required." }, 400);
    }

    // Asked before the grant is looked up, and before anything reaches a vendor. The grant says this
    // Bot may use the tool; it says nothing about whether this person may act as this Bot, and the
    // call goes out on the deployment's own credential either way.
    if (!(await canUseBot(context.var.actor, body.agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }

    try {
      const result = await store.callTool({
        ref: body.ref,
        args: body.args ?? {},
        botId: body.agentId,
        /*
         * The user id, not the address.
         *
         * `callTool` keys a per-person connection on `users.id`, so an address here finds nothing and
         * every call through this route would be answered "you have not connected your account" —
         * about a connector the person has connected. It never surfaced because a Bot's own tool loop
         * runs on the server and does not come through here.
         *
         * The other uses of `actorEmail` in this file are `by:` on configuration changes, where an
         * address is the useful thing to record. This one is an identity being resolved, not a name
         * being written down, and the two are not interchangeable.
         */
        actorId: context.var.actor.id,
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      /*
       * Ours, and so neither the vendor's fault nor this caller's business.
       *
       * CRITERION. A fault on the `isDeploymentFault` shelf is not reported through the branch
       * below, and its sentence does not leave this process by this route.
       *
       * REASON. Two things would be wrong at once. `failed: true` and 502 say somebody else's
       * software did not answer, which is a false statement about a call that never went out —
       * and this route is `requireUser`, not `requireAdmin`, so the sentence naming our columns
       * and the correction to make would be readable by anybody with a session. The operator who
       * can act on it reads it on the refresh route above, which is admin-gated; here the honest
       * answer is that the deployment cannot make this call as it stands.
       */
      if (isDeploymentFault(error)) {
        return context.json(
          {
            error:
              "That tool is not configured in a way this deployment can act on. An administrator has to look at the server it belongs to.",
          },
          500,
        );
      }
      // A server that failed is not a refusal, and saying so matters: one means the deployment
      // decided against it, the other means somebody else's software did not answer.
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The server did not answer.",
          failed: true,
        },
        502,
      );
    }
  });

  return routes;
}
