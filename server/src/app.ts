import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { authoriseAgentCall, sameToken } from "./agents/callback-token";
import type { BotAccessCheck } from "./agents/profile-policy";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import {
  type AuditReader,
  type AuditStore,
  auditQueryFromUrl,
  recordAuditEvent,
} from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
  requireAdmin,
} from "./auth/guards";
import type { IdentityProviderStore } from "./auth/identity-provider-store";
import { avatarResponse, avatarUrl, parseAvatarImage } from "./avatar";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createThreadReader } from "./channels/thread-status";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import type { ActionActor, ComputerGateway } from "./computer/gateway";
import type { PageFrameStore } from "./computer/page-frames";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes } from "./computer/routes";
import { configuredAuthProviders, type DeploymentConfig } from "./config";
import type { CredentialAdminService, CredentialInput } from "./credentials";
import { createIntelligenceClient } from "./intelligence-client";
import type { OnboardingStore } from "./people/onboarding";
import type { PeopleStore } from "./people/store";
import { createPluginRoutes } from "./plugins/routes";
import type { PluginStore } from "./plugins/store";
import { REFUSAL_MARKER } from "./plugins/tools";
import { createRoutineRoutes, type RoutineStore } from "./routines/routes";
import type { RoutineRunner } from "./routines/runner";
import type { IntentRouter } from "./routing/classify";
import { createRoutingRoutes } from "./routing/routes";
import type { PackageStatusReader } from "./tenant-package";

/**
 * One row for something an administrator did to somebody's access.
 *
 * The address is on the row rather than only the user id, because the id means nothing to a person
 * reading the trail a year later and the user row may be gone by then.
 */
async function recordPersonEvent(
  auditStore: AuditStore | undefined,
  context: { var: AppVariables },
  eventType:
    | "person.role_changed"
    | "person.access_revoked"
    | "person.access_restored",
  person: { id: string; email: string },
  payload: Record<string, unknown>,
) {
  if (!auditStore) return;
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "person",
    targetId: person.id,
    actorUserId: context.var.actor.id,
    payload: { email: person.email, ...payload },
  });
}

const CODEX_COMPUTER_TOOL_PREFIX = "openbot_computer_";

/**
 * Execute a Codex computer alias through the same gateway used by the browser tools.
 *
 * The alias matters: AG-UI also carries these tool events back to the browser, where the unprefixed
 * `computer_*` names have frontend handlers. Returning an unprefixed name after executing here would
 * click, type, or navigate twice.
 */
async function callCodexComputerTool(
  gateway: ComputerGateway,
  name: string,
  args: Record<string, unknown>,
  botId: string,
  actorId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!name.startsWith(CODEX_COMPUTER_TOOL_PREFIX)) return undefined;

  const tool = name.slice("openbot_".length);
  const actor: ActionActor = { id: actorId };
  switch (tool) {
    case "computer_navigate":
      return gateway.navigate(botId, actor, stringArgument(args, "url"));
    case "computer_read":
      return gateway.read(botId);
    case "computer_snapshot":
      return gateway.snapshot(botId);
    case "computer_click":
      return gateway.click(
        botId,
        actor,
        {
          ref: stringArgument(args, "ref"),
          snapshotId: numberArgument(args, "snapshotId"),
        },
        signal,
      );
    case "computer_type": {
      const submit = booleanArgument(args, "submit");
      return gateway.type(
        botId,
        actor,
        {
          ref: stringArgument(args, "ref"),
          snapshotId: numberArgument(args, "snapshotId"),
          text: stringArgument(args, "text"),
          ...(submit === undefined ? {} : { submit }),
        },
        signal,
      );
    }
    case "computer_key": {
      const ref = optionalStringArgument(args, "ref");
      const snapshotId = optionalNumberArgument(args, "snapshotId");
      return gateway.key(
        botId,
        actor,
        {
          key: stringArgument(args, "key"),
          ...(ref === undefined ? {} : { ref }),
          ...(snapshotId === undefined ? {} : { snapshotId }),
        },
        signal,
      );
    }
    case "computer_scroll": {
      const deltaY = optionalNumberArgument(args, "deltaY");
      return gateway.scroll(
        botId,
        actor,
        deltaY === undefined ? {} : { deltaY },
      );
    }
    case "computer_list_files": {
      const path = optionalStringArgument(args, "path");
      return gateway.listFiles(
        botId,
        actor,
        path === undefined ? {} : { path },
      );
    }
    case "computer_read_file":
      return gateway.readFile(botId, actor, {
        path: stringArgument(args, "path"),
      });
    case "computer_run_command":
      return gateway.runCommand(
        botId,
        actor,
        { command: stringArgument(args, "command") },
        signal,
      );
    case "computer_write_file": {
      const append = booleanArgument(args, "append");
      return gateway.writeFile(botId, actor, {
        path: stringArgument(args, "path"),
        contents: stringArgument(args, "contents"),
        ...(append === undefined ? {} : { append }),
      });
    }
    default:
      throw new Error("That computer tool is not available to remote agents.");
  }
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function optionalStringArgument(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  return stringArgument(args, name);
}

function numberArgument(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }
  return value;
}

function optionalNumberArgument(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  if (args[name] === undefined) return undefined;
  return numberArgument(args, name);
}

function booleanArgument(
  args: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  roleRepository?: RoleRepository,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** The single governed computer module: policy, audit trail, transport, and provider lifecycle. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * Who has signed in, and what an administrator may do about them.
   *
   * Absent leaves the people screen answering 503 rather than an empty list, which is the honest
   * degraded behaviour: "nobody has signed in" and "this deployment cannot tell you" are different
   * answers and an administrator deciding who has access needs to know which one they are reading.
   */
  peopleStore?: PeopleStore,
  /**
   * The enterprise identity providers this deployment has registered.
   *
   * Read here rather than through Better Auth's own listing route, which scopes to the person asking:
   * a company's Okta tenant belongs to the deployment, not to whichever administrator pasted the
   * metadata in. See identity-provider-store.ts.
   */
  identityProviders?: IdentityProviderStore,
  /**
   * Chooses which coworker an untagged message is for, before a channel is pinned to one.
   *
   * Passed in already built, like the copilot handler, so this module never imports the model
   * client. Absent leaves the composer's existing behaviour untouched: an untagged message goes to
   * the default coworker, which is exactly the failsafe the router itself falls back to.
   */
  intentRouter?: IntentRouter,
  /**
   * Where the frame a browsing turn ended on is kept.
   *
   * Appended last on purpose: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the transcript working and past turns without a picture, which is the correct
   * degraded behaviour: a conversation that cannot show what it saw is better than one that shows
   * the wrong thing.
   */
  pageFrames?: PageFrameStore,
  /**
   * Fires one routine run with nobody's browser open, when the worker hands one back.
   *
   * Appended last, like `pageFrames`: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the internal `/internal/routines/run` route unmounted rather than mounted and
   * refusing every call: a deployment that never built a worker has no door for it, not a locked one.
   */
  routineRunner?: RoutineRunner,
  /**
   * A person's own standing instructions: the list, and a switch to stop one.
   *
   * Appended last, like `routineRunner` beside it: these are positional, so inserting one anywhere
   * else silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same
   * degraded shape every other optional store here takes: a deployment that never built the store
   * has no door for this at all, not a locked one.
   */
  routineStore?: RoutineStore,
  /**
   * Where each person is in first-run onboarding.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves /api/me reporting no onboarding to track, which is the correct degraded
   * behaviour: a deployment that cannot read the status must not lock everybody behind a gate
   * nothing can finish.
   */
  onboardingStore?: OnboardingStore,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/health", (context) => context.json({ status: "ok" }));
  // Projected, never the raw runtime. config.runtime carries the Intelligence contract, including
  // INTELLIGENCE_API_KEY and the licence token, and this endpoint is reachable by anyone. Returning
  // the object wholesale would serve deployment secrets to the browser. Add fields here explicitly.
  app.get("/api/capabilities", async (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
      /*
       * Whether a Bot may answer with an interface it wrote itself.
       *
       * Projected because the browser holds half of this capability. The runtime middleware turns a
       * generated interface into the events that paint it, and the SDK's provider registers the tool
       * that produces one; a deployment that switched the runtime half off while the browser went on
       * offering the tool would have Bots writing interfaces nothing ever draws. One flag, read by
       * both halves, so off means off.
       */
      generativeUi: config.generativeUi,
      /*
       * Which identity providers this deployment can sign somebody in with.
       *
       * Ids only, never the credentials: `configuredAuthProviders` returns names, and the clients
       * and secrets behind them stay in `config.auth`, which is not projected here.
       *
       * Answered at runtime rather than baked into the build, because the container image is built
       * once and knows nothing about the deployment that will run it. A sign-in screen compiled on a
       * build machine cannot offer a provider that machine had never heard of.
       */
      authProviders: configuredAuthProviders(config.auth),
      /*
       * Whether any enterprise identity provider has been registered.
       *
       * A count, not a list. The sign-in screen only needs to know whether to offer the email box
       * that routes by domain; naming the providers would tell anybody who loads the page which
       * companies use this deployment, which is not theirs to have before they sign in.
       */
      ssoConfigured: ((await identityProviders?.list()) ?? []).length > 0,
    }),
  );
  /*
   * Registering an identity provider is an administrator's decision, not a signed-in one.
   *
   * Better Auth's SSO plugin guards these with `sessionMiddleware`, which asks only that somebody is
   * signed in. That is the wrong bar here: registering an IdP for a domain means anybody it vouches
   * for can sign in, so a plain user reaching this could mint themselves colleagues. The routes are
   * mounted through this handler, so the check goes in front of it.
   */
  const ADMIN_ONLY_AUTH_ROUTES = new Set([
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ]);

  app.on(["GET", "POST"], "/api/auth/*", async (context) => {
    if (!auth) {
      return context.json(
        { error: "No identity provider is configured." },
        503,
      );
    }

    if (ADMIN_ONLY_AUTH_ROUTES.has(new URL(context.req.url).pathname)) {
      const session = await auth.api.getSession({
        headers: context.req.raw.headers,
        // Fresh, not the cookie cache: a role changed a moment ago has to apply to this request.
        query: { disableCookieCache: true },
      });
      const roles = session?.user
        ? ((await roleRepository?.rolesForUser(session.user.id)) ?? [])
        : [];
      if (!roles.includes("admin")) {
        return context.json(
          { error: "Only an administrator may change identity providers." },
          403,
        );
      }
    }

    return auth.handler(context.req.raw);
  });

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json({ error: "No identity provider is configured." }, 503);
  // One administrator, when nothing is configured to sign anybody in. Checked first, and only ever
  // true when there is no provider, so a configured deployment cannot fall back to it.
  const requireUser = config.singleUser
    ? createDevRequireUser()
    : auth && roleRepository
      ? createRequireUser(auth, roleRepository)
      : authenticationUnavailable;

  app.get("/api/me", requireUser, async (context) => {
    const avatarImage =
      (await peopleStore?.avatar(context.var.actor.id)) ?? null;
    return context.json({
      user: {
        ...context.var.actor,
        image:
          avatarUrl("/api/me/avatar/image", avatarImage) ??
          context.var.actor.image ??
          null,
        hasCustomAvatar: avatarImage !== null,
        /*
         * Read here rather than in the guard, so only this route pays the extra query. Null means
         * this deployment does not track onboarding, which the app reads as nothing to finish;
         * a not-yet-completed status is what sends it to /onboarding.
         */
        onboarding: onboardingStore
          ? await onboardingStore.status(context.var.actor.id)
          : null,
      },
    });
  });
  app.put(
    "/api/me/avatar",
    requireUser,
    bodyLimit({
      maxSize: 3 * 1024 * 1024,
      onError: (context) =>
        context.json({ error: "Avatar image must be 2 MB or smaller." }, 413),
    }),
    async (context) => {
      if (!peopleStore) {
        return context.json(
          { error: "Profile storage is not available." },
          503,
        );
      }
      const body = (await context.req.json().catch(() => null)) as {
        image?: unknown;
      } | null;
      const parsed = parseAvatarImage(body?.image);
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);

      await peopleStore.setAvatar(context.var.actor.id, parsed.value);
      return context.json({
        avatar: {
          image:
            avatarUrl("/api/me/avatar/image", parsed.value) ??
            context.var.actor.image ??
            null,
          hasCustomAvatar: parsed.value !== null,
        },
      });
    },
  );
  app.get("/api/me/avatar/image", requireUser, async (context) => {
    const image = (await peopleStore?.avatar(context.var.actor.id)) ?? null;
    if (!image) return context.json({ error: "Avatar not found." }, 404);
    return avatarResponse(image);
  });
  app.post("/api/me/onboarding", requireUser, async (context) => {
    if (!onboardingStore) {
      return context.json({ error: "Onboarding is not available." }, 503);
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { step?: unknown; completed?: unknown }
      | undefined;

    if (body?.completed === true) {
      await onboardingStore.complete(context.var.actor.id);
    } else if (
      typeof body?.step === "number" &&
      Number.isInteger(body.step) &&
      body.step >= 0 &&
      // The column's range — the only bound the server knows, since the wizard's length is the
      // app's fact rather than the deployment's.
      body.step <= 2_147_483_647
    ) {
      await onboardingStore.setStep(context.var.actor.id, body.step);
    } else {
      return context.json(
        { error: "Send the step to move to, or completed: true." },
        400,
      );
    }

    return context.json({
      onboarding: await onboardingStore.status(context.var.actor.id),
    });
  });
  app.get("/api/admin/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!auditReader) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }

    return context.json(
      await auditReader.list(auditQueryFromUrl(new URL(context.req.url))),
    );
  });
  /*
   * Who is here, and what they may do.
   *
   * Administrator-only, like every other route in this group. A plain user reading the list would
   * learn every colleague's address and when they last signed in, which is not theirs to have.
   */
  app.get("/api/admin/people", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    /*
     * A page, not the deployment.
     *
     * `limit` is clamped by the store, so a caller cannot ask for everybody by naming a large
     * number. `search` is what makes paging usable: an administrator looking for one colleague
     * should not have to walk pages to reach them.
     */
    const url = new URL(context.req.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

    return context.json(
      await peopleStore.list({
        ...(url.searchParams.get("search")
          ? { search: url.searchParams.get("search") as string }
          : {}),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    );
  });

  app.post("/api/admin/people/:userId/role", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    const body = await context.req.json().catch(() => null);
    const role = (body as { role?: unknown } | null)?.role;
    if (role !== "admin" && role !== "user") {
      return context.json(
        { error: "A role of admin or user is required." },
        400,
      );
    }

    const userId = context.req.param("userId");
    const person = await peopleStore.find(userId);
    if (!person) {
      return context.json({ error: "That person is not here." }, 404);
    }

    /*
     * The configured floor wins over the screen.
     *
     * Somebody named in INITIAL_ADMIN_EMAILS is promoted again at their next sign-in whatever this
     * route writes, so allowing the demotion would produce a screen that lies until they come back.
     * Refusing says the real thing: change the deployment's configuration.
     */
    if (person.configuredAdmin && role !== "admin") {
      return context.json(
        {
          error:
            "This deployment names that address in INITIAL_ADMIN_EMAILS, so they stay an administrator. Change the configuration instead.",
        },
        409,
      );
    }

    /*
     * Nobody demotes themselves.
     *
     * An administrator who does has just locked themselves out of the screen that would undo it,
     * and on a deployment with one administrator that is the whole deployment. Somebody else with
     * the role can do it, which is the check that makes handover possible without making lockout
     * a slip of the finger.
     */
    if (context.var.actor.id === userId && role !== "admin") {
      return context.json(
        { error: "You cannot remove your own administrator role." },
        409,
      );
    }

    if (person.role !== role) {
      await peopleStore.setRole(userId, role);
      await recordPersonEvent(
        auditStore,
        context,
        "person.role_changed",
        person,
        {
          from: person.role,
          to: role,
        },
      );
    }

    return context.json({ person: await peopleStore.find(userId) });
  });

  app.post("/api/admin/people/:userId/access", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    const body = await context.req.json().catch(() => null);
    const revoked = (body as { revoked?: unknown } | null)?.revoked;
    if (typeof revoked !== "boolean") {
      return context.json({ error: "revoked must be true or false." }, 400);
    }

    const userId = context.req.param("userId");
    const person = await peopleStore.find(userId);
    if (!person) {
      return context.json({ error: "That person is not here." }, 404);
    }

    // The same floor, for the same reason: removing somebody the configuration names would last
    // until their next sign-in and no longer.
    if (person.configuredAdmin && revoked) {
      return context.json(
        {
          error:
            "This deployment names that address in INITIAL_ADMIN_EMAILS, so they cannot be removed here. Change the configuration instead.",
        },
        409,
      );
    }

    // Nobody can remove themselves. An administrator who does has locked themselves out of the
    // screen that would undo it.
    if (revoked && context.var.actor.id === userId) {
      return context.json({ error: "You cannot remove your own access." }, 409);
    }

    if (person.revoked !== revoked) {
      if (revoked) {
        await peopleStore.revoke(userId, context.var.actor.id);
      } else {
        await peopleStore.restore(userId);
      }
      await recordPersonEvent(
        auditStore,
        context,
        revoked ? "person.access_revoked" : "person.access_restored",
        person,
        {},
      );
    }

    return context.json({ person: await peopleStore.find(userId) });
  });

  /*
   * The identity providers this deployment has registered.
   *
   * Not Better Auth's own `GET /sso/providers`, which answers with the ones the person asking
   * registered themselves. Two administrators therefore saw two different deployments: the second
   * one to open this screen found it empty and registered a provider that was already there. What is
   * registered is a fact about the deployment, so every administrator sees the same list.
   */
  app.get("/api/admin/identity-providers", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!identityProviders) {
      return context.json(
        { error: "Identity providers are not available." },
        503,
      );
    }

    return context.json({ providers: await identityProviders.list() });
  });

  /*
   * Remove one.
   *
   * Ours rather than Better Auth's `delete-provider`, which refuses unless the person asking is the
   * one who registered it. That leaves a provider nobody can remove as soon as the administrator who
   * set it up has left, which is the same moment somebody most needs to.
   */
  app.delete(
    "/api/admin/identity-providers/:providerId",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!identityProviders) {
        return context.json(
          { error: "Identity providers are not available." },
          503,
        );
      }

      const providerId = context.req.param("providerId");
      const removed = await identityProviders.remove(providerId);
      if (!removed) {
        // A screen somebody left open, or two administrators removing the same one. Saying so beats
        // reporting success for something that was not there.
        return context.json({ error: "There is no such provider." }, 404);
      }

      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "identity_provider.removed",
          targetType: "identity_provider",
          targetId: providerId,
          actorUserId: context.var.actor.id,
          payload: { removedBy: context.var.actor.email },
        });
      }

      return context.json({ removed: true });
    },
  );

  app.get("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json({ error: "Credential input is invalid." }, 400);
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json({ error: "Credential input is invalid." }, 400);
      }

      return context.json({
        credential: await credentialService.rotate({
          ...input,
          previousCredentialId: context.req.param("credentialId"),
        }),
      });
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      return context.json({
        credential: await credentialService.revoke(
          context.req.param("credentialId"),
          context.var.actor.id,
        ),
      });
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!packageStatusReader) {
      return context.json({ error: "Tenant package is not configured." }, 503);
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  /*
   * Where the worker hands a routine run back. Not under /api and not behind requireUser: the
   * worker is not a person with a session, it is another process on this deployment's own network,
   * and the shared secret below is its whole credential.
   *
   * Mounted only when a runner was built, so a deployment that never stood up a worker has no door
   * for this at all, rather than one that is mounted and permanently refuses.
   */
  if (routineRunner) {
    app.post("/internal/routines/run", async (context) => {
      const offered = context.req.header("authorization");
      const expected = config.workerSharedSecret
        ? `Bearer ${config.workerSharedSecret}`
        : null;
      /*
       * The no-secret-configured case is refused here, before any comparison, and with the exact
       * same response as a wrong secret. A deployment with no worker must not answer a guess any
       * differently than a deployment with a worker and a wrong key would.
       */
      if (!expected || !offered || !sameToken(offered, expected)) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row. A
         * worker with a stale or missing secret used to fail here in total silence: every routine
         * stopped firing and nothing anywhere said why, the same false negative `mcp.callback_refused`
         * exists to catch on the sibling unauthenticated boundary above.
         *
         * The reason is short and lives only in the row, never on the wire: the response below stays
         * byte-identical across all three causes on purpose (see the comment above), so this is the
         * one place the distinction is allowed to exist. The offered credential itself is never
         * recorded, not even a fragment of it.
         */
        if (auditStore) {
          try {
            await recordAuditEvent(auditStore, {
              eventType: "routines.dispatch_refused",
              targetType: "worker",
              payload: {
                reason: !expected
                  ? "unconfigured"
                  : !offered
                    ? "missing-header"
                    : "mismatch",
                note: "A worker's bearer secret did not check out, so no routine run was dispatched.",
              },
            });
          } catch (error) {
            // Never fatal: the 401 above is already decided and sent. A trail that is briefly
            // unavailable is not a reason to turn a refusal into a 500.
            console.error(
              JSON.stringify({
                type: "routine-dispatch-audit-write-failed",
                error: String(error),
              }),
            );
          }
        }
        return context.json({ error: "This endpoint is the worker's." }, 401);
      }
      const body = await context.req.json().catch(() => null);
      if (
        typeof (body as { routineRunId?: unknown } | null)?.routineRunId !==
        "string"
      ) {
        return context.json({ error: "A routineRunId is required." }, 400);
      }
      /*
       * Fire and answer: the consumer needs "accepted", not the outcome. The run row in
       * `routine_runs` carries the outcome, and the consumer finishes the work item on this 202.
       * Queue retries exist for DISPATCH failures only — a failed turn is final for this firing, and
       * the fatigue rule owns it. `run()` never throws by contract; this swallow only guards against
       * that contract being wrong without turning a bug there into an unhandled rejection here.
       */
      void routineRunner
        .run((body as { routineRunId: string }).routineRunId)
        .catch(() => {});
      return context.json({ accepted: true }, 202);
    });
  }
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow an OpenBot route declared above.
  if (copilotHandler) {
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The browser
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  /**
   * May this person act as this Bot?
   *
   * The store's own read path already applies `canAccessAgent`, so asking it for the Bot is the same
   * question the roster and the runtime ask, rather than a second copy of the rule.
   *
   * A deployment with no profile store has no agents table and therefore no private Bot to protect:
   * its Bots come from the tenant package and are public to everybody who can sign in. Answering yes
   * there keeps that deployment working without weakening one that has owners.
   */
  const canUseBot: BotAccessCheck = agentProfileStore
    ? async (actor, botId) =>
        (await agentProfileStore.get(actor, botId)) !== null
    : async () => true;

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so both arrive
  // together or the routes are not mounted. An ungoverned computer is not a reduced feature. It is
  // the one shape of this feature that must not exist.
  if (computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerGateway,
        computerPolicy,
        requireUser,
        canUseBot,
        pageFrames,
        auditReader,
      ),
    );
  }

  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // The same stance the computer uses: a laptop legitimately talks to its own services, a hosted
        // deployment must not. Passed from configuration rather than defaulted here, so "hosted and
        // permissive" cannot happen by forgetting something.
        config.computer?.allowPrivateHosts ?? false,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
        // Addresses this deployment named, which is how a hosted one reaches an agent on its own
        // network without dropping the floor for everything else.
        config.agentEndpointAllowedHosts,
        /*
         * What the Bot's own screen needs to show, and change, which Bots it may hand work to.
         *
         * Read per request rather than captured, for the reason the desk reads it per hop: a grant
         * made a minute ago counts and one revoked a minute ago stops counting. Absent with no
         * plugin store, which is a deployment where no Bot may address any other.
         */
        pluginStore
          ? {
              enabled:
                config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0,
              reachableFrom: (agentId) =>
                pluginStore.botsReachableFrom(agentId),
              // The same answer the write path checks, read up front so the screen can say it once.
              runsHere: (agentId) => pluginStore.agentRunsHere(agentId),
            }
          : undefined,
        // Whether "built-in" is a kind of coworker this deployment can actually make: the create
        // path falls back to the managed Bot's endpoint, so without one it can only refuse.
        config.managedAgent !== undefined,
        // The managed Bot's address, so a coworker created without an endpoint — which creation
        // stores as running at this address — can be told apart from one a person hosts.
        config.managedAgent?.endpoint.toString(),
      ),
    );
    // Choosing a coworker for an untagged message needs the same permission-filtered roster the
    // agents routes read, so it is mounted here where that store is in scope. Only when a router was
    // configured; without one the composer keeps sending untagged messages to the default.
    if (intentRouter) {
      app.route(
        "/api/route",
        createRoutingRoutes(
          agentProfileStore,
          intentRouter,
          requireUser,
          auditStore,
          /*
           * Which vendors each coworker holds tools for, so the router weighs what a coworker can
           * reach and not only what somebody wrote it was for. Only when there is a plugin store to
           * ask: a deployment with no connectors routes exactly as it did.
           */
          pluginStore
            ? async (agentId) => {
                const granted = await pluginStore.listForAgent(agentId);
                return [
                  ...new Set(
                    granted.tools.map(
                      (tool) =>
                        tool.toolName.replace(/^mcp__/, "").split("__")[0] ??
                        tool.toolName,
                    ),
                  ),
                ];
              }
            : undefined,
        ),
      );
    }
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(channelStore, requireUser, channelEvents, auditStore),
    );
  }

  if (routineStore) {
    app.route("/api/routines", createRoutineRoutes(routineStore, requireUser));
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(componentStore, requireUser, auditStore, canUseBot),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(pluginStore, requireUser, canUseBot, {
        encryptionKey: config.keyEncryptionKey,
        /*
         * Whether the person a consent was started for still has access, asked when the callback
         * lands rather than when the flow began.
         *
         * The callback carries no session — identity comes from the state — so this is where the
         * question gets asked at all. `find` answers both halves of it: no row means a user id that
         * names nobody, and `revoked` means an administrator removed them while they were away at
         * the vendor. Either way there is no live person for a fresh refresh token to belong to.
         *
         * No people store means this deployment cannot answer the question, so it refuses rather
         * than assuming yes. It also cannot remove anybody, which is exactly why guessing here
         * would be a hole nothing else closes.
         */
        personHasAccess: async (userId) => {
          if (!peopleStore) return false;
          const person = await peopleStore.find(userId);
          return person !== undefined && !person.revoked;
        },
        // The deployment-wide fallback a Bot may present, as a yes or no. The secret itself stays
        // in config and is checked in `/api/agent-tools/call`; the surface only needs to know
        // whether a Bot without its own credential has any way to call back.
        botsMayCallBack: Boolean(config.agentToolToken),
        publicUrl: config.publicUrl,
        appUrl: config.appUrl,
      }),
    );
  }

  /*
   * Where a framework Bot runs a tool.
   *
   * A Bot that runs its own loop, in its own process, is the honest shape: the run does not need a
   * browser and does not stop when one closes. What it must not have is a route to a vendor that
   * goes around this deployment, so it calls here and this calls the plugin store, which asks the
   * same two questions it asks of everything else and writes the same audit row.
   *
   * Authenticated by a shared secret rather than a session, because the caller is a service and has
   * no person behind it. Absent secret means the route does not exist: a deployment that has not
   * configured this refuses rather than accepting anybody who can reach the port.
   */
  if (pluginStore || computerGateway) {
    const legacyToken = config.agentToolToken ?? "";
    app.post("/api/agent-tools/call", async (context) => {
      /*
       * Who is calling, and on whose behalf. Two questions, two credentials.
       *
       * The header says which agent: its own token, issued to it, stored here only as a hash. The
       * body's `run` says which Bot and which person, signed by this deployment for this run.
       *
       * Both are required, and they are checked against each other. This used to be one
       * deployment-wide token with the Bot and the actor read straight out of the body, which meant
       * anything holding that token could spend any Bot's grants and write any name into the audit
       * trail. A forgeable trail is worse than no trail, because it is believed.
       */
      const body = (await context.req.json().catch(() => null)) as {
        name?: string;
        args?: Record<string, unknown>;
        run?: unknown;
      } | null;

      const verdict = await authoriseAgentCall({
        presented: context.req.header("x-openbot-agent-token") ?? "",
        run: body?.run,
        encryptionKey: config.keyEncryptionKey,
        legacyToken,
        lookup: async (hash) =>
          (await agentProfileStore?.agentForCallbackToken(hash)) ?? null,
      });
      if (!verdict.ok) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row.
         *
         * The three outcomes inside `callTool` are all written after the caller has proved which Bot
         * it is. A caller that fails to prove it never reaches them, so this refusal used to leave
         * nothing at all — and it is the refusal behind the product's most confusing failure: a Bot
         * whose token no longer matches the deployment's has every call rejected here, returns
         * nothing to its own model, and the model tells the person there were no results. A false
         * negative delivered as an answer, with the trail agreeing nothing had happened.
         *
         * No Bot id and no actor. Both live in the credential that just failed to verify, so writing
         * them down would put an unproven claim in the record. The tool name comes from the body and
         * is capped for the same reason: it is untrusted input, kept because "which tool was being
         * reached for" is the useful half of the question.
         */
        if (auditStore) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.callback_refused",
            targetType: "mcp_tool",
            targetId:
              typeof body?.name === "string"
                ? body.name.slice(0, 120)
                : "unknown",
            payload: {
              refusal: verdict.reason,
              status: verdict.status,
              note: "A caller could not prove which Bot it was, so no grant was consulted.",
            },
          });
        }
        return context.json({ error: verdict.reason }, verdict.status);
      }

      if (!body?.name) {
        return context.json({ error: "A tool is required." }, 400);
      }

      try {
        if (body.name.startsWith(CODEX_COMPUTER_TOOL_PREFIX)) {
          if (!computerGateway) {
            throw new Error(
              "This deployment has no governed computer gateway.",
            );
          }
          const args =
            body.args &&
            typeof body.args === "object" &&
            !Array.isArray(body.args)
              ? body.args
              : {};
          const result = await callCodexComputerTool(
            computerGateway,
            body.name,
            args,
            verdict.botId,
            verdict.actorId,
            context.req.raw.signal,
          );
          const outcome =
            result && typeof result === "object" && !Array.isArray(result)
              ? { ok: true, ...result }
              : { ok: true, result };
          return context.json({
            text: JSON.stringify(outcome),
            isError: false,
          });
        }
        if (!pluginStore) {
          throw new Error("This deployment has no plugin tool gateway.");
        }
        const result = await pluginStore.callTool({
          // The model is offered `mcp__server__tool`; the store speaks `server/tool`.
          ref: body.name.replace(/^mcp__/, "").replace("__", "/"),
          args: body.args ?? {},
          botId: verdict.botId,
          // From the assertion, never the body: this is the name the audit row will carry.
          actorId: verdict.actorId,
        });
        return context.json({ text: result.text, isError: result.isError });
      } catch (error) {
        // A refusal is an answer, not a failure: the Bot says what was blocked and carries on. The
        // marker leads it so a transcript can draw a refusal without reading the wording.
        return context.json({
          text: `${REFUSAL_MARKER} ${error instanceof Error ? error.message : "That tool could not be called."}`,
          isError: true,
        });
      }
    });
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  if (threadIdentity) {
    app.route(
      "/api/threads",
      createThreadRoutes(
        threadIdentity,
        requireUser,
        // config.ts refuses to boot without the full Intelligence contract (see copilot.ts's
        // header comment), so `config.runtime.intelligence` is never missing here. Built from it
        // rather than assumed, though: this is the one place besides the runtime mount itself that
        // needs to reach Intelligence, and it should keep working unmodified if that guarantee ever
        // loosens and a deployment can legitimately have no reader to build.
        createThreadReader(
          createIntelligenceClient(config.runtime.intelligence),
        ),
      ),
    );
  }

  /*
   * The built app, served by the API that serves it.
   *
   * WHY THE SAME PROCESS. There is no CORS anywhere in this server, deliberately, so the app has to
   * reach `/api` on its own origin. Two containers behind one ingress does that too, and costs a
   * path rule on every deployment plus a way for the two to disagree about which host they are on.
   * One process cannot disagree with itself.
   *
   * MOUNTED LAST, so every `/api` route above already claimed its path. The catch-all below would
   * otherwise answer an unmatched `/api` call with the app's HTML, which is the failure that reads
   * as "the API returned HTML" and takes an hour to place.
   *
   * Absent in development: Vite serves the app and proxies `/api` here, so `APP_DIST_DIR` is unset
   * and none of this mounts.
   */
  if (config.appDistDir) {
    const root = config.appDistDir;
    app.use("/*", serveStatic({ root }));
    /*
     * A single-page app owns its routing, so a path with no file behind it is not missing: it is a
     * route the browser resolves once index.html has loaded. Without this, every deep link and every
     * refresh away from `/` is a 404, which is the classic way this deployment shape breaks.
     *
     * Written out rather than a second `serveStatic`, whose `path` option is resolved relative to the
     * working directory and silently matches nothing when handed the absolute root used above.
     *
     * `/api` is excluded so an unmatched API route still answers as one. Returning the app's HTML to
     * a fetch that expected JSON is the failure that gets read as "the API returned HTML".
     */
    app.get("*", async (context) => {
      if (context.req.path.startsWith("/api")) return context.notFound();
      const index = Bun.file(`${root}/index.html`);
      if (!(await index.exists())) return context.notFound();
      return new Response(index, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  }

  return app;
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * An allowlist, and deliberately narrower than `CredentialKind`.
   *
   * `CredentialKind` is derived from the schema enum, so it now includes `mcp_oauth_client` and
   * `mcp_user_token`. Neither belongs here. A user token is somebody's own grant and exists only as
   * the outcome of a consent they gave; a client is registered when a connector is added. Both are
   * written by the code that owns those flows, and an administrator hand-posting either would be
   * creating a credential attributed to a person who never agreed to it.
   *
   * So this list is not out of date with the enum — do not widen it to match.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    typeof body.keyId !== "string" ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata)
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider,
    keyId: body.keyId,
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}
