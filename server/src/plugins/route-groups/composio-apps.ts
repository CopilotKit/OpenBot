import { requireAdmin } from "../../auth/guards";
import { reasonWithoutStatement } from "../../db/query-failure";
import { BROKERED_PROFILE } from "../access";
import {
  type BrokerApp,
  BrokerUnconfiguredError,
  brokerSentence,
} from "../broker";
import { vendorSentence } from "../composio";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  deploymentFaultSentence,
  isDeploymentFault,
  PluginRefusedError,
  type ServerRecord,
} from "../store";
import {
  brokerRefusal,
  directoryUnavailable,
  type PluginRouteContext,
  withVendorDeadline,
} from "./context";

/** Browsing Composio's directory and enabling an app out of it. */
export function mountComposioAppRoutes({
  routes,
  store,
  requireUser,
  composio,
  activeProvider,
  activeVendor,
  appOfUrl,
  actorEmail,
}: PluginRouteContext) {
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
   * `enabled` comes off `appOfUrl(url)` — the active broker's own parser — and never off the
   * row's id. The url is where the transport reads which app a call is against, so it is the only
   * reading that decides anything;
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
        {
          error: new BrokerUnconfiguredError(activeProvider, "operator")
            .message,
        },
        503,
      );
    }

    let directory: BrokerApp[];
    try {
      directory = await withVendorDeadline(() => composio.broker.listApps());
    } catch (error) {
      // The vendor's own sentence where there is one, because "invalid api key" is the diagnosis
      // and a 500 is not. See {@link brokerRefusal} for what is kept out of the answer.
      const refusal = brokerRefusal(
        error,
        directoryUnavailable(activeProvider),
      );
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
        .map((url) => appOfUrl(url))
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
    const outcome = await enableComposioApp(
      { store, composio, activeProvider, activeVendor },
      slug,
      actorEmail(context),
    );
    return outcome.ok
      ? context.json({ server: outcome.server }, 201)
      : context.json({ error: outcome.error }, outcome.status);
  });
}

/** What enabling one Composio app answered: the row it wrote, or the refusal and its status. */
export type EnableOutcome =
  | { ok: true; server: ServerRecord }
  | { ok: false; error: string; status: 400 | 409 | 502 | 503 };

/**
 * Enable one app of Composio's catalogue, by slug: the body of `POST /composio/apps`, and what
 * approving a person's request to switch an app on runs.
 *
 * ONE FUNCTION FOR BOTH DOORS, so an app switched on from the request inbox is checked against
 * the live directory, refused when this deployment cannot drive it, and mapped to the same
 * sentences as one switched on from the picker. The caller decides who may call it; both callers
 * are administrator-only.
 */
export async function enableComposioApp(
  {
    store,
    composio,
    activeProvider,
    activeVendor,
  }: Pick<
    PluginRouteContext,
    "store" | "composio" | "activeProvider" | "activeVendor"
  >,
  slug: string | undefined,
  by: string,
): Promise<EnableOutcome> {
  if (!composio) {
    return {
      ok: false,
      error: new BrokerUnconfiguredError(activeProvider, "operator").message,
      status: 503,
    };
  }
  let directory: BrokerApp[] = [];
  if (slug) {
    try {
      directory = await withVendorDeadline(() => composio.broker.listApps());
    } catch (error) {
      /*
       * The same failure the directory route answers, in the same words, because it is the same
       * call. Unhandled it was the worst 500 of the three: an administrator pressing Add on a
       * deployment whose key is wrong was told nothing at all, on the one screen where the key
       * had just been set.
       */
      return {
        ok: false,
        ...brokerRefusal(error, directoryUnavailable(activeProvider)),
      };
    }
  }
  const app = directory.find((candidate) => candidate.slug === slug);
  if (!app) {
    return {
      ok: false,
      error: slug
        ? `${slug} is not an app ${BROKERED_PROFILE[activeProvider].vendor} lists for this deployment.`
        : "An app is required.",
      status: 400,
    };
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
    return { ok: false, error: app.connection.reason, status: 503 };
  }

  try {
    const server = await store.addBrokeredApp({
      slug: app.slug,
      title: app.name,
      logo: app.logo,
      by,
      // Off the directory entry the administrator chose, never derived a second time here: a
      // second derivation is a second answer, which is the one thing `BrokerConnection` exists to
      // prevent. It decides what config the store creates at the vendor, and what the row records.
      connection: app.connection,
    });
    return { ok: true, server };
  } catch (error) {
    // The same mapping the add routes above make, for the same reason: a refusal an
    // administrator can correct comes back as itself rather than as a 500.
    if (
      error instanceof CustomServerRefusedError ||
      error instanceof PluginRefusedError
    ) {
      return { ok: false, error: error.message, status: 400 };
    }
    // And, as on those routes, enabling refreshes before it answers, so every fault
    // `refreshTools` raises arrives here as well. Its sentence blames nobody and names the row,
    // which is the honest answer whichever side of the insert the fault arrived on.
    if (isDeploymentFault(error)) {
      return {
        ok: false,
        error: deploymentFaultSentence(error),
        status: 409,
      };
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
      return {
        ok: false,
        error: `${app.name} was added, and then could not be read back out of this deployment's own servers — so the row and its trail entry stand, and what is on this page may be missing it. Reload the Plugins page: if ${app.name} is there it is enabled and there is nothing to redo, and if it is not, adding it again is safe.`,
        status: 409,
      };
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
          note: `Enabling a brokered app failed for a reason neither this deployment nor ${activeVendor} put a sentence to. The administrator was answered 502 with the generic sentence.`,
          error: reasonWithoutStatement(error),
        }),
      );
    }

    return {
      ok: false,
      ...brokerRefusal(
        error,
        `${app.name} could not be enabled, and ${activeVendor} said nothing about why. Try again, and check this deployment's ${activeVendor} key if it persists.`,
      ),
    };
  }
}
