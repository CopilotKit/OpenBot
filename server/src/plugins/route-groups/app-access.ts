import type { Context } from "hono";
import { type AppVariables, requireAdmin } from "../../auth/guards";
import { BROKERED_PROFILE, type BrokerProvider } from "../access";
import type { Unavailable } from "../app-access";
import type { CatalogueEntry } from "../catalogue";
import type {
  AppAccessRequestRecord,
  AppDirectory,
} from "../plugin-store/app-access";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  deploymentFaultSentence,
  isDeploymentFault,
} from "../store";
import { enableComposioApp } from "./composio-apps";
import type { PluginRouteContext } from "./context";
import { sharedGrantApproval } from "./grants";

type RouteContext = Context<{ Variables: AppVariables }>;

/**
 * The longest app name or Bot id a request may carry — the same cap the `show_app_access` tool puts
 * on what a model may ask about. Both are written into the trail when a filing is refused, and an
 * app's name becomes the title an administrator reads in the inbox, so neither is a field a caller
 * may fill with whatever they like.
 */
const MAX_NAME = 200;

/**
 * How many requests one person may have waiting at once. A real person asks about the handful of
 * apps a question needed; past this the inbox is being filled rather than asked, and each extra row
 * is one an administrator has to answer by hand.
 */
export const MAX_PENDING_REQUESTS = 20;

/**
 * What enabling a catalogue entry would need that only an administrator can type, or null when
 * adding its row is the whole of it.
 *
 * A vendor that gives every customer their own host needs that host; a deployment token needs the
 * token; an OAuth client that does not register itself needs the client. Approving a request
 * cannot invent any of those, so it says which one is missing and leaves the request pending.
 */
function adminInputFor(entry: CatalogueEntry): string | null {
  if (entry.host === null) return `the address of your ${entry.title} instance`;
  if (entry.auth.kind === "deployment-bearer")
    return "the token it is reached with";
  if (
    entry.auth.kind === "user-oauth" &&
    entry.auth.clientRegistration !== "dynamic"
  )
    return "an OAuth client registered with the vendor";
  return null;
}

/**
 * The sentence an approval is refused with when the app is there and still cannot be used.
 *
 * The broker's name and key come from {@link BROKERED_PROFILE}, so an Arcade deployment is told
 * to set ARCADE_API_KEY in the words a Composio one is told to set COMPOSIO_API_KEY.
 */
function unavailableSentence(
  reason: Unavailable,
  title: string,
  provider: BrokerProvider,
): string {
  switch (reason) {
    case "absent":
      return `${title} can't be turned on from here.`;
    case "composio_unconfigured": {
      const { vendor, envVar } = BROKERED_PROFILE[provider];
      const article = /^[aeiou]/i.test(vendor) ? "an" : "a";
      return `${title} is ${article} ${vendor} app, and ${envVar} isn't set. Set it, then approve this request again.`;
    }
    case "scheme_unreadable":
      return `${title} is turned on, but OpenBot can't read how it connects. Remove it and turn it on again under Plugins, then approve this request again.`;
    case "oauth_client_missing":
      return `${title} has no OAuth client yet. Register one on its page under Plugins, then approve this request again.`;
    case "token_missing":
      return `${title} has no token yet. Add one on its page under Plugins, then approve this request again.`;
  }
}

/**
 * Where a person sees which work apps a Bot can use for them, asks an administrator for the ones
 * only an administrator can fix, and where the administrator answers.
 *
 * THE STATE IS ALWAYS THE SERVER'S. A person's browser names a Bot and an app; what the app is for
 * them, and therefore what a request asks for, is computed here from the same tables every gate
 * reads. A request cannot be filed for a state the app is not in, and approving one does the thing
 * that state was missing — switching the app on, granting it to the Bot — in the same press.
 *
 * WHY NOT `shared_use_requests`. That table answers a different question: a Shared app whose team
 * account IS connected, and whether an administrator approves the audience a Bot exposes it to.
 * "Please connect the team account" is a request about the account itself, before any audience can
 * matter, and has none of that table's columns to fill. The style, the conditional decide and the
 * audit vocabulary are that flow's; the rows are not.
 */
export function mountAppAccessRoutes({
  routes,
  store,
  requireUser,
  canUseBot,
  composio,
  shared,
  actorEmail,
  activeProvider,
  activeVendor,
}: PluginRouteContext) {
  const composioConfigured = Boolean(composio);
  /*
   * Asked only to name an app this deployment has no row for — see `readDirectory` in the store.
   * The adapter caches the listing, so a card asking about an app nobody enabled costs a vendor
   * call at most once per cache window rather than once per render.
   */
  const directory: AppDirectory | undefined = composio
    ? () => composio.broker.listApps()
    : undefined;
  /*
   * What the shared-use gate would answer this person's chat through this Bot, so a Shared app
   * whose audience was never approved reads as refused rather than ready. Without the store there
   * is no gate to ask, and the call path refuses every Shared call anyway; the state says `ready`
   * there exactly as it did before this was asked.
   */
  const sharedAudience = shared?.use.admitsPerson;

  const refused = async (
    context: RouteContext,
    input: {
      app: string;
      reason: string;
      error: string;
      status: 400 | 403 | 404 | 409 | 429 | 502 | 503;
      request?: string;
      bot?: string | null;
      kind?: string;
    },
  ) => {
    await store.recordAppAccessEvent({
      eventType: "app_access.refused",
      targetId: input.app,
      actorUserId: context.var.actor.id,
      payload: {
        app: input.app,
        reason: input.reason,
        ...(input.request ? { request: input.request } : {}),
        ...(input.bot !== undefined ? { bot: input.bot } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      },
    });
    return context.json({ error: input.error }, input.status);
  };

  /**
   * Every work app this Bot holds, with what each one is for the person asking.
   *
   * Only for a Bot the person may use, and answered 404 otherwise, for the reason the grant list
   * beside it gives: what a private Bot holds is a fact about that Bot.
   */
  routes.get("/for/:agentId/apps", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId)))
      return context.json({ error: "There is no such Bot." }, 404);
    return context.json({
      apps: await store.appAccessForBot({
        userId: context.var.actor.id,
        agentId,
        composioConfigured,
        directory,
        sharedAudience,
      }),
    });
  });

  /**
   * One app, by key or by name, whether or not this Bot holds it — so a card in a conversation can
   * say an app is switched off or not granted, and offer the request that fixes it.
   */
  routes.get("/for/:agentId/apps/:app", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId)))
      return context.json({ error: "There is no such Bot." }, 404);
    const app = context.req.param("app");
    const inspected =
      app.length > MAX_NAME
        ? null
        : await store.inspectApp({
            app,
            agentId,
            userId: context.var.actor.id,
            composioConfigured,
            directory,
            sharedAudience,
          });
    if (!inspected)
      return context.json({ error: `OpenBot has no app called ${app}.` }, 404);
    return context.json({ app: inspected.access });
  });

  /**
   * Ask an administrator for access. The body names the Bot and the app; the kind is the server's.
   *
   * A SECOND PRESS IS THE FIRST REQUEST. One pending request per person, app, Bot and kind, so
   * asking again answers with the one already waiting and `created: false`, and writes no second
   * trail row.
   *
   * ONLY FOR AN APP SOMETHING VOUCHES FOR, AND ONLY SO MANY. Asking to enable a `composio-` id the
   * directory does not list would put whatever the caller typed in front of an administrator as an
   * app's name, for an approval that can only fail; it is answered as no such app, unless the Bot
   * already holds a grant for it and the request is about putting back something it was given. And
   * a person with {@link MAX_PENDING_REQUESTS} waiting is told to wait for those to be answered.
   */
  routes.post("/access-requests", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
      app?: unknown;
    } | null;
    const agentId =
      typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const app = typeof body?.app === "string" ? body.app.trim() : "";
    if (!agentId || !app)
      return context.json({ error: "Name the Bot and the app." }, 400);
    if (agentId.length > MAX_NAME || app.length > MAX_NAME)
      return context.json(
        {
          error: `Bot and app names are ${MAX_NAME} characters at most.`,
        },
        400,
      );
    if (!(await canUseBot(context.var.actor, agentId)))
      return refused(context, {
        app,
        bot: agentId,
        reason: "no_such_bot",
        error: "There is no such Bot.",
        status: 404,
      });
    const found = await store.inspectApp({
      app,
      agentId,
      userId: context.var.actor.id,
      composioConfigured,
      directory,
      sharedAudience,
    });
    const inspected =
      found && (found.vouched || found.access.granted) ? found : null;
    if (!inspected)
      return refused(context, {
        app,
        bot: agentId,
        reason: "no_such_app",
        error: `OpenBot has no app called ${app}.`,
        status: 404,
      });
    const { access } = inspected;
    if (!access.requestKind)
      return refused(context, {
        app: access.key,
        bot: agentId,
        reason: `nothing_to_request:${access.state}`,
        error:
          access.state === "ready"
            ? `${access.displayName} is ready to use. There's nothing to ask an admin for.`
            : `${access.displayName} needs your own account, not an admin. Connect it yourself.`,
        status: 409,
      });
    /*
     * The one already waiting is answered as itself before the cap is counted, so a person at the
     * cap pressing again on a request they filed is shown it, not refused.
     */
    if (
      !access.request &&
      (await store.countPendingAppAccessRequests(context.var.actor.id)) >=
        MAX_PENDING_REQUESTS
    )
      return refused(context, {
        app: access.key,
        bot: agentId,
        reason: "too_many_pending",
        kind: access.requestKind,
        error: `You already have ${MAX_PENDING_REQUESTS} requests waiting for an admin. Withdraw one, or wait for an answer, then ask again.`,
        status: 429,
      });
    const filed = await store.fileAppAccessRequest({
      requestedBy: context.var.actor.id,
      agentId,
      appKey: access.key,
      appTitle: access.displayName,
      kind: access.requestKind,
    });
    return context.json(filed, filed.created ? 201 : 200);
  });

  /** The person's own pending requests, newest first. */
  routes.get("/access-requests/mine", requireUser, async (context) =>
    context.json({
      requests: await store.pendingAppAccessRequests({
        requestedBy: context.var.actor.id,
      }),
    }),
  );

  /**
   * Withdraw one's own pending request. Somebody else's reads exactly like one that does not exist,
   * so this route cannot be used to learn who asked for what.
   */
  routes.delete("/access-requests/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    const closed = await store.closeAppAccessRequest({
      id,
      status: "cancelled",
      by: context.var.actor.id,
      requestedBy: context.var.actor.id,
    });
    if (!closed) {
      const existing = await store.appAccessRequest(id);
      const mine = existing?.requestedBy === context.var.actor.id;
      return refused(context, {
        app: mine ? (existing?.appKey ?? "") : "",
        request: id,
        reason: mine ? "already_resolved" : "no_such_request",
        error: mine
          ? "That request has already been answered."
          : "There is no such request.",
        status: mine ? 409 : 404,
      });
    }
    await store.recordAppAccessEvent({
      eventType: "app_access.cancelled",
      targetId: closed.appKey,
      actorUserId: context.var.actor.id,
      payload: {
        request: closed.id,
        app: closed.appKey,
        bot: closed.agentId,
        kind: closed.kind,
      },
    });
    return context.json({ request: closed });
  });

  /**
   * Every pending request, for an administrator: one app's with `?app=`, or all of them, and a
   * count per app either way so the Plugins list can badge each app without a second read.
   */
  routes.get("/access-requests", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const all = await store.pendingAppAccessRequests({});
    const byApp: Record<string, number> = {};
    for (const request of all)
      byApp[request.appKey] = (byApp[request.appKey] ?? 0) + 1;
    const app = context.req.query("app")?.trim();
    return context.json({
      requests: app ? all.filter((request) => request.appKey === app) : all,
      counts: { total: all.length, byApp },
    });
  });

  /**
   * Approve a request by doing what it asks: switch the app on, grant its tools to the Bot, or —
   * for a team account, which only a consent screen can connect — confirm it has been connected.
   *
   * CLAIMED, THEN CHANGED. The request is closed as approved by this administrator before anything
   * is changed, so a dismiss, a withdrawal or a second approval arriving meanwhile finds it answered
   * and loses, and the change can never land under a request somebody else answered. A change that
   * cannot be carried out puts the request back, and it waits again with the step that is missing;
   * so does one that throws. See `claimAppAccessRequest` in the store, which says why this is not a
   * row lock held across the change.
   *
   * `refs` NARROWS THE GRANT, AND WITHOUT IT ONLY THE READS ARE GRANTED. One press in the inbox
   * gives the Bot every action the app has marked read-only — what the Bot page's bulk switch
   * offers, and nothing that sends, writes or deletes. Anything more is chosen action by action, on
   * the Bot's page for the app or by naming them here. An app with no read-only action is refused
   * with that sentence rather than granted everything. A ref outside the app is refused rather than
   * dropped.
   */
  routes.post("/access-requests/:id/approve", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const id = context.req.param("id");
    const body = (await context.req.json().catch(() => null)) as {
      refs?: unknown;
    } | null;
    if (
      body?.refs !== undefined &&
      (!Array.isArray(body.refs) ||
        body.refs.some((ref) => typeof ref !== "string"))
    )
      return context.json({ error: "Tools must be a list of refs." }, 400);
    const chosen = body?.refs as string[] | undefined;

    let carriedOut = false;
    const approve = async (request: AppAccessRequestRecord) => {
      const deny = (
        reason: string,
        error: string,
        status: 400 | 404 | 409 | 502 | 503,
      ) =>
        refused(context, {
          app: request.appKey,
          request: request.id,
          bot: request.agentId,
          kind: request.kind,
          reason,
          error,
          status,
        });

      const inspect = () =>
        store.inspectApp({
          app: request.appKey,
          agentId: request.agentId ?? "",
          userId: null,
          composioConfigured,
          directory,
        });

      let inspected = await inspect();
      if (!inspected)
        return deny(
          "no_such_app",
          `${request.appTitle} isn't available anymore.`,
          409,
        );

      let enabled = false;
      if (request.kind !== "connect_shared" && inspected.unavailable) {
        const title = inspected.access.displayName;
        if (inspected.unavailable !== "absent")
          return deny(
            inspected.unavailable,
            unavailableSentence(inspected.unavailable, title, activeProvider),
            inspected.unavailable === "composio_unconfigured" ? 503 : 409,
          );
        if (inspected.toolkit) {
          if (!composio)
            return deny(
              "composio_unconfigured",
              unavailableSentence(
                "composio_unconfigured",
                title,
                activeProvider,
              ),
              503,
            );
          const outcome = await enableComposioApp(
            { store, composio, activeProvider, activeVendor },
            inspected.toolkit,
            actorEmail(context),
          );
          if (!outcome.ok)
            return deny("enable_failed", outcome.error, outcome.status);
        } else if (inspected.entry) {
          const needed = adminInputFor(inspected.entry);
          if (needed)
            return deny(
              "needs_admin_input",
              `${title} needs ${needed}. Add it on its page under Plugins, then approve this request again.`,
              409,
            );
          try {
            await store.addServer({
              key: inspected.entry.key,
              by: actorEmail(context),
            });
          } catch (error) {
            if (
              error instanceof CatalogueEntryUnknownError ||
              error instanceof CustomServerRefusedError
            )
              return deny("enable_failed", error.message, 400);
            if (isDeploymentFault(error))
              return deny("enable_failed", deploymentFaultSentence(error), 409);
            throw error;
          }
        } else {
          return deny(
            "absent",
            unavailableSentence("absent", title, activeProvider),
            409,
          );
        }
        enabled = true;
        inspected = await inspect();
        if (!inspected || inspected.unavailable)
          return deny(
            "enable_failed",
            `${title} was turned on but still can't be used. Open its page under Plugins to see why.`,
            409,
          );
      }

      let granted: string[] = [];
      if (
        request.kind !== "connect_shared" &&
        request.agentId &&
        !inspected.access.granted
      ) {
        const agentId = request.agentId;
        const serverId = inspected.answeringId;
        const name = inspected.access.displayName;
        if (!(await store.agentIsRegistered(agentId)) || !serverId)
          return deny("no_such_bot", "That Bot is no longer here.", 409);
        const tools = await store.appTools(serverId);
        const advertised = tools.map((tool) => tool.ref);
        const refs =
          chosen ?? tools.filter((tool) => tool.read).map((tool) => tool.ref);
        const outside = refs.filter((ref) => !advertised.includes(ref));
        if (outside.length > 0)
          return deny(
            "refs_outside_app",
            `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not among ${name}'s tools.`,
            400,
          );
        if (advertised.length === 0)
          return deny(
            "no_tools",
            `${name} has no tools to give yet. Refresh its tools on its page under Plugins, then approve this request again.`,
            409,
          );
        if (refs.length === 0)
          return deny(
            "no_read_only_tools",
            `None of ${name}'s actions are marked read-only, so approving here gives this Bot nothing. Choose its actions on ${name}'s page under Plugins, then approve this request again.`,
            409,
          );
        for (const ref of refs) {
          await store.grant("mcp", ref, agentId, actorEmail(context));
        }
        const sharedDecision = await sharedGrantApproval(
          { store, shared },
          refs[0] ?? "",
          agentId,
          undefined,
        );
        if (
          sharedDecision !== "unreadable" &&
          sharedDecision.approval &&
          shared
        )
          await shared.use.setApproval({
            botId: agentId,
            serverId: sharedDecision.appId,
            approval: sharedDecision.approval,
            by: context.var.actor.id,
          });
        granted = refs;
      }

      if (
        request.kind === "connect_shared" &&
        inspected.access.account === "shared" &&
        !inspected.sharedUsable
      )
        return deny(
          "shared_not_connected",
          `The shared ${inspected.access.displayName} account is not connected yet. Connect it on ${inspected.access.displayName}'s page under Plugins, then approve this request.`,
          409,
        );

      carriedOut = true;
      const closed = request;
      await store.recordAppAccessEvent({
        eventType: "app_access.approved",
        targetId: closed.appKey,
        actorUserId: context.var.actor.id,
        payload: {
          request: closed.id,
          app: closed.appKey,
          bot: closed.agentId,
          kind: closed.kind,
          enabled,
          granted: granted.length,
        },
      });
      return context.json({ request: closed, enabled, granted });
    };

    const claimed = await store.claimAppAccessRequest({
      id,
      by: context.var.actor.id,
    });
    if (!claimed) {
      const existing = await store.appAccessRequest(id);
      return refused(context, {
        app: existing?.appKey ?? "",
        request: id,
        reason: existing ? "already_resolved" : "no_such_request",
        error: existing
          ? "That request has already been answered."
          : "There is no such request.",
        status: existing ? 409 : 404,
      });
    }
    try {
      return await approve(claimed);
    } finally {
      if (!carriedOut)
        await store.releaseAppAccessRequest({ id, by: context.var.actor.id });
    }
  });

  /** Dismiss a request: nothing changes but the request, which stops waiting. */
  routes.post("/access-requests/:id/dismiss", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const id = context.req.param("id");
    const closed: AppAccessRequestRecord | null =
      await store.closeAppAccessRequest({
        id,
        status: "dismissed",
        by: context.var.actor.id,
      });
    if (!closed) {
      const existing = await store.appAccessRequest(id);
      return refused(context, {
        app: existing?.appKey ?? "",
        request: id,
        reason: existing ? "already_resolved" : "no_such_request",
        error: existing
          ? "That request has already been answered."
          : "There is no such request.",
        status: existing ? 409 : 404,
      });
    }
    await store.recordAppAccessEvent({
      eventType: "app_access.dismissed",
      targetId: closed.appKey,
      actorUserId: context.var.actor.id,
      payload: {
        request: closed.id,
        app: closed.appKey,
        bot: closed.agentId,
        kind: closed.kind,
      },
    });
    return context.json({ request: closed });
  });
}
