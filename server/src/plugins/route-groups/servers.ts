import { requireAdmin } from "../../auth/guards";
import { reasonWithoutStatement } from "../../db/query-failure";
import { brokerSentence, schemeKind } from "../broker";
import { CATALOGUE } from "../catalogue";
import { vendorSentence } from "../composio";
import { redirectUriFor } from "../oauth";
import { asAccountMode } from "../shared-accounts";
import { asSharedUseApproval, type SharedUseApproval } from "../shared-use";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  deploymentFaultSentence,
  isDeploymentFault,
} from "../store";
import { brokerRefusal, type PluginRouteContext } from "./context";

/** Adding, removing and refreshing MCP servers, and an app's account mode. */
export function mountServerRoutes({
  routes,
  store,
  requireUser,
  connect,
  composio,
  shared,
  activeProvider,
  activeVendor,
  appOfUrl,
  actorEmail,
  skillActor,
}: PluginRouteContext) {
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
      /*
       * Whether this deployment's broker authorizes ONE ACTION AT A TIME, as a declared capability.
       *
       * A PRESENCE TEST ON A VALUE THE BROKER DECLARED, computed from the same expression the two
       * routes that run that flow gate on — `/servers/:id/authorize` and the `/arcade/verify`
       * return leg both read `composio.broker.authorizations`. The screen that draws the per-action
       * grant list used to gate on `provider === "arcade"` instead, so the screen and the routes
       * keyed on different facts: a broker named arcade reached with `authorizations` null would
       * have drawn the list and 503'd every Authorize press. See {@link
       * ConnectedAppBroker.authorizations} and `store.ts`'s gate comment, which records a defect of
       * exactly that shape.
       *
       * A capability, never a name: what the screen asks is what the broker can DO, and two
       * providers are free to share an answer. `provider` beside it stays a NAME and answers a
       * different question — which vendor to put in copy.
       *
       * False on Composio, whose auth config fixes one state for a whole toolkit, so every Composio
       * render is unchanged.
       */
      authorizesPerAction: Boolean(composio?.broker.authorizations),
      /*
       * WHICH vendor brokers this deployment's apps, as a name.
       *
       * Handed in with the broker, never read off it: the broker declares what it can do, not who
       * it is, and a name sniffed from it would be the comparison the store argues against.
       *
       * A screen that FILTERS by brokered-ness needs no provider name. One provider holds rows at a
       * time, so a predicate over a row's provenance is enough. A screen that NAMES a vendor
       * ("Browse Composio", the `/admin/plugins/composio` route, the key's setting, "Reached
       * through Composio") cannot derive that name from a row, and this is the only thing that
       * answers it. It is separate from `composioConfigured`, which asks whether the directory can
       * be browsed at all.
       *
       * A NAME, never a key and never a capability. The Plugins page is reachable by any signed-in
       * person, so nothing about the vendor key (its presence, shape or anything derived from it)
       * travels with this. Composio when no broker is configured, so that deployment is unchanged —
       * read from {@link activeProvider}, which is also what the brokered reads below parse with, so
       * the name this page shows and the parser those routes use cannot come apart.
       */
      provider: activeProvider,
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
      key?: unknown;
      instanceHost?: unknown;
      credentialId?: unknown;
    } | null;
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key) {
      return context.json({ error: "A catalogue key is required." }, 400);
    }
    // Optional fields travel to `input.credentialId?.trim()` in the store, where a number or
    // object throws a TypeError that escapes as a 500. A string that is only whitespace would
    // silently become `undefined` there, so it is refused here instead of being coerced.
    if (
      body?.instanceHost !== undefined &&
      (typeof body.instanceHost !== "string" || !body.instanceHost.trim())
    ) {
      return context.json(
        { error: "An instance host must be a non-empty string." },
        400,
      );
    }
    if (
      body?.credentialId !== undefined &&
      (typeof body.credentialId !== "string" || !body.credentialId.trim())
    ) {
      return context.json(
        { error: "A credential id must be a non-empty string." },
        400,
      );
    }

    try {
      const server = await store.addServer({
        key,
        instanceHost:
          typeof body?.instanceHost === "string"
            ? body.instanceHost.trim()
            : undefined,
        credentialId:
          typeof body?.credentialId === "string"
            ? body.credentialId.trim()
            : undefined,
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
      id?: unknown;
      title?: unknown;
      url?: unknown;
      credentialId?: unknown;
    } | null;
    if (
      typeof body?.id !== "string" ||
      !body.id.trim() ||
      typeof body?.title !== "string" ||
      !body.title.trim() ||
      typeof body?.url !== "string" ||
      !body.url.trim()
    ) {
      return context.json(
        { error: "A name, a title and a URL are required." },
        400,
      );
    }
    // `addCustomServer` dereferences `input.credentialId?.trim()`, so a number or object here
    // throws a TypeError that escapes as a 500 instead of a 400.
    if (
      body.credentialId !== undefined &&
      (typeof body.credentialId !== "string" || !body.credentialId.trim())
    ) {
      return context.json(
        { error: "A credential id must be a non-empty string." },
        400,
      );
    }

    try {
      const server = await store.addCustomServer({
        id: body.id.trim(),
        title: body.title.trim(),
        url: body.url.trim(),
        credentialId:
          typeof body.credentialId === "string"
            ? body.credentialId.trim()
            : undefined,
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
      clientId?: unknown;
      clientSecret?: unknown;
    } | null;
    /*
     * `typeof` before `.trim()`, as `POST /servers` and `/servers/custom` do: the body is JSON, so
     * `{"clientId": 12345}` or a secret of `{}` used to reach `.trim()` here, outside the try, and
     * answer 500 for what is a person's malformed request.
     */
    if (
      typeof body?.clientId !== "string" ||
      typeof body.clientSecret !== "string" ||
      !body.clientId.trim() ||
      !body.clientSecret.trim()
    ) {
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
    /*
     * READ BEFORE THE ROW GOES. The ask-before-write rule a Shared app was given lives in the
     * approval policy, not on the row, so nothing cascades it away; asked afterwards, the mode is
     * gone with the row and the rule would outlive the account it guarded.
     */
    const wasShared =
      shared !== undefined &&
      (await store.serverAddress(serverId))?.accountMode === "shared";
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
            note: `Removing a server failed for a reason neither this deployment nor ${activeVendor} put a sentence to. The administrator was answered 502 with the generic sentence, and the server row is still there.`,
            error: reasonWithoutStatement(error),
          }),
        );
      }

      const refusal = brokerRefusal(
        error,
        `Removing this app did not finish, and neither this deployment nor ${activeVendor} said why, so the app is still here rather than gone with grants of its own left live at the vendor. Press Remove again: every account is withdrawn at ${activeVendor} before anything here is deleted, so repeating it is safe and asks only for what is left. Check this deployment's ${activeVendor} key if it persists.`,
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
    /*
     * THE SAME SHAPE AS THE MINT'S RECORD-AFTER-THE-FACT BELOW, AND GUARDED FOR THE SAME REASON.
     * `removeServer` has already returned, which means every account was withdrawn AT THE VENDOR
     * and every row here is gone — none of it undoable, and none of it repeatable either: a second
     * Remove finds no app. Unhandled, a fault tidying up the one leftover ask-before-write rule
     * answered that completed removal with a bodyless 500, so the administrator was told the
     * removal failed and had no press left to make.
     *
     * SO THE ANSWER STAYS `ok`, BECAUSE THE REMOVAL REALLY DID HAPPEN, and the leftover is named on
     * the console instead: a revoked-rule row that outlives the app it guarded, which an
     * administrator can retire from the rules screen and which grants nobody anything meanwhile.
     */
    if (wasShared) {
      try {
        await shared?.modes.forgetRule(serverId, context.var.actor.id);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "shared-rule-not-forgotten",
            server: serverId,
            note: "An app was removed, at the vendor and here, and its ask-before-write rule could not be retired afterwards. The administrator was answered ok, because the removal is done and cannot be repeated; the rule is still standing.",
            error: reasonWithoutStatement(error),
          }),
        );
      }
    }
    return context.json({ ok: true });
  });

  /**
   * Personal ⇄ Shared. Without `confirm`, a preview of what the switch would end and approve; with
   * it, the switch itself, which changes nothing unless every old account was ended at the vendor.
   */
  routes.put("/servers/:id/account-mode", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    if (!shared) {
      return context.json(
        { error: "Shared accounts are not available on this deployment." },
        503,
      );
    }
    const body = (await context.req.json().catch(() => null)) as {
      mode?: unknown;
      confirm?: unknown;
      approvals?: unknown;
    } | null;
    const mode = asAccountMode(body?.mode);
    if (!mode)
      return context.json({ error: "Choose personal or shared." }, 400);
    const serverId = context.req.param("id");
    const row = await store.serverAddress(serverId);
    if (!row || !appOfUrl(row.url)) {
      return context.json(
        { error: "That app is not reached through a broker." },
        400,
      );
    }
    if (schemeKind(row.authScheme) === "none") {
      return context.json(
        {
          error: `${row.title} needs no account, so there is nothing to share.`,
        },
        400,
      );
    }
    const approvals: Record<string, SharedUseApproval> = {};
    if (body?.approvals && typeof body.approvals === "object") {
      for (const [botId, value] of Object.entries(
        body.approvals as Record<string, unknown>,
      )) {
        const approval = asSharedUseApproval(value);
        if (!approval) {
          return context.json(
            {
              error: `The approval for ${botId} is not one this deployment can read.`,
            },
            400,
          );
        }
        approvals[botId] = approval;
      }
    }
    try {
      const result = await shared.modes.switchMode({
        serverId,
        mode,
        by: context.var.actor.id,
        confirm: body?.confirm === true,
        approvals,
      });
      if ("failures" in result) {
        return context.json(
          {
            ...result,
            error: result.failures.map((failure) => failure.error).join(" "),
          },
          502,
        );
      }
      return context.json(result);
    } catch (error) {
      const refusal = brokerRefusal(
        error,
        "The switch did not finish, and nothing was changed.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
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
}
