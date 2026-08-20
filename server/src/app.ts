import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import { type AuditReader, type AuditStore, auditQueryFromUrl } from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
  requireAdmin,
} from "./auth/guards";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import type { ComputerClient } from "./computer/client";
import type { ComputerGateway } from "./computer/gateway";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes } from "./computer/routes";
import { authoriseAgentCall } from "./agents/callback-token";
import type { DeploymentConfig } from "./config";
import type { CredentialAdminService, CredentialInput } from "./credentials";
import { createPluginRoutes } from "./plugins/routes";
import { REFUSAL_MARKER } from "./plugins/tools";
import type { PluginStore } from "./plugins/store";
import type { PackageStatusReader } from "./tenant-package";

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
  /** Absent when no computer is configured, and the routes are then not mounted at all. */
  computerClient?: ComputerClient,
  /** The only path to an acting call: policy decision, then audit row, then the action. */
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
) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/health", (context) => context.json({ status: "ok" }));
  // Projected, never the raw runtime. config.runtime carries the Intelligence contract, including
  // INTELLIGENCE_API_KEY and the licence token, and this endpoint is reachable by anyone. Returning
  // the object wholesale would serve deployment secrets to the browser. Add fields here explicitly.
  app.get("/api/capabilities", (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (context) => {
    if (!auth) {
      return context.json(
        { error: "Google authentication is not configured." },
        503,
      );
    }

    return auth.handler(context.req.raw);
  });

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json({ error: "Google authentication is not configured." }, 503);
  // Local development can stand in a fixed administrator so the product is reachable before the
  // authentication slice is built. It is checked first so a machine with the flag set does not also
  // need Google credentials configured just to boot.
  const requireUser = config.devNoAuth
    ? createDevRequireUser()
    : auth && roleRepository
      ? createRequireUser(auth, roleRepository)
      : authenticationUnavailable;

  app.get("/api/me", requireUser, (context) =>
    context.json({ user: context.var.actor }),
  );
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
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow an OpenBot route declared above.
  if (copilotHandler) {
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The client
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so all
  // three arrive together or the routes are not mounted: a computer whose actions were ungoverned is
  // not a reduced feature, it is the one shape of this feature that must not exist.
  if (computerClient && computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerClient,
        computerGateway,
        computerPolicy,
        requireUser,
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
      ),
    );
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(channelStore, requireUser, channelEvents),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(componentStore, requireUser, auditStore),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(pluginStore, requireUser, {
        encryptionKey: config.keyEncryptionKey,
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
  if (pluginStore) {
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
        return context.json({ error: verdict.reason }, verdict.status);
      }

      if (!body?.name) {
        return context.json({ error: "A tool is required." }, 400);
      }

      try {
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
    app.route("/api/threads", createThreadRoutes(threadIdentity, requireUser));
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
