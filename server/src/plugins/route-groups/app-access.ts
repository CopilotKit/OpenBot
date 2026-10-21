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
      return `${title} is not an app this deployment can switch on from here.`;
    case "composio_unconfigured": {
      const { vendor, envVar } = BROKERED_PROFILE[provider];
      const article = /^[aeiou]/i.test(vendor) ? "an" : "a";
      return `${title} is ${article} ${vendor} app, and this deployment has no ${vendor} key. Set ${envVar}, then approve this request again.`;
    }
    case "scheme_unreadable":
      return `${title} is enabled, but how it connects is not recorded in a way this deployment can read. Remove it and enable it again on its page under Plugins, then approve this request again.`;
    case "oauth_client_missing":
      return `${title} is added, but has no OAuth client yet, so nobody can connect it. Register one on its page under Plugins, then approve this request again.`;
    case "token_missing":
      return `${title} is added, but has no token yet. Add one on its page under Plugins, then approve this request again.`;
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

  const refused = async (
    context: RouteContext,
    input: {
      app: string;
      reason: string;
      error: string;
      status: 400 | 403 | 404 | 409 | 502 | 503;
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
    const inspected = await store.inspectApp({
      app,
      agentId,
      userId: context.var.actor.id,
      composioConfigured,
      directory,
    });
    if (!inspected)
      return context.json(
        { error: `This deployment has no app called ${app}.` },
        404,
      );
    return context.json({ app: inspected.access });
  });

  /**
   * Ask an administrator for access. The body names the Bot and the app; the kind is the server's.
   *
   * A SECOND PRESS IS THE FIRST REQUEST. One pending request per person, app, Bot and kind, so
   * asking again answers with the one already waiting and `created: false`, and writes no second
   * trail row.
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
    if (!(await canUseBot(context.var.actor, agentId)))
      return refused(context, {
        app,
        bot: agentId,
        reason: "no_such_bot",
        error: "There is no such Bot.",
        status: 404,
      });
    const inspected = await store.inspectApp({
      app,
      agentId,
      userId: context.var.actor.id,
      composioConfigured,
      directory,
    });
    if (!inspected)
      return refused(context, {
        app,
        bot: agentId,
        reason: "no_such_app",
        error: `This deployment has no app called ${app}.`,
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
            ? `${access.displayName} is ready to use. There is nothing to ask an administrator for.`
            : `${access.displayName} is waiting on your own account, not on an administrator. Connect it yourself.`,
        status: 409,
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
   * THE CHANGE FIRST, THEN THE CONDITIONAL CLOSE. Enabling and granting are both idempotent, so
   * two administrators approving at once both arrive at the same deployment and one of them is
   * told the request was already answered. Closing first would leave an approved request over a
   * change that then failed.
   *
   * `refs` NARROWS THE GRANT. Absent, the Bot is granted every tool the app advertises — which is
   * what "let this Bot use Gmail" means — and every call is still policy-checked and audited. A
   * ref outside the app is refused rather than dropped.
   */
  routes.post("/access-requests/:id/approve", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const id = context.req.param("id");
    const request = await store.appAccessRequest(id);
    if (request?.status !== "pending")
      return refused(context, {
        app: request?.appKey ?? "",
        request: id,
        reason: request ? "already_resolved" : "no_such_request",
        error: request
          ? "That request has already been answered."
          : "There is no such request.",
        status: request ? 409 : 404,
      });
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
        `${request.appTitle} is no longer an app this deployment can find.`,
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
            unavailableSentence("composio_unconfigured", title, activeProvider),
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
            `${title} needs ${needed}, which only an administrator can supply. Add it on its page under Plugins, then approve this request again.`,
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
          `${title} was switched on and still cannot be used. Open its page under Plugins to see why.`,
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
      if (!(await store.agentIsRegistered(agentId)) || !serverId)
        return deny("no_such_bot", "That Bot is no longer here.", 409);
      const advertised = await store.appToolRefs(serverId);
      const refs = chosen ?? advertised;
      const outside = refs.filter((ref) => !advertised.includes(ref));
      if (outside.length > 0)
        return deny(
          "refs_outside_app",
          `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not among ${inspected.access.displayName}'s tools.`,
          400,
        );
      if (refs.length === 0)
        return deny(
          "no_tools",
          `${inspected.access.displayName} advertises no tools to grant yet. Refresh its tools on its page under Plugins, then approve this request again.`,
          409,
        );
      for (const ref of refs) {
        await store.grant("mcp", ref, agentId, actorEmail(context));
      }
      const decided = await sharedGrantApproval(
        { store, shared },
        refs[0] ?? "",
        agentId,
        undefined,
      );
      if (decided !== "unreadable" && decided.approval && shared)
        await shared.use.setApproval({
          botId: agentId,
          serverId: decided.appId,
          approval: decided.approval,
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

    const closed = await store.closeAppAccessRequest({
      id: request.id,
      status: "approved",
      by: context.var.actor.id,
    });
    if (!closed)
      return deny(
        "already_resolved",
        "That request has already been answered.",
        409,
      );
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
