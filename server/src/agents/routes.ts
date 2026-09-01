import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { avatarResponse, avatarUrl, parseAvatarImage } from "../avatar";
import { testAgentConnection } from "./connection-test";
import { checkAgentEndpoint } from "./endpoint";
import { canCustomizeAgentAvatar, canManageAgent } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ManagedAgentUnavailableError,
  ProtectedAgentError,
} from "./profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type AgentInputParseResult =
  | { ok: true; value: CreateAgentInput }
  | { ok: false; error: string };

type AgentInputObject = {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  visibility?: unknown;
  endpoint?: unknown;
  auth?: unknown;
};

/**
 * Parse and validate what a user typed into the agent form.
 *
 * `allowPrivateHosts` is passed in rather than read from configuration here so this stays a pure
 * function: a developer's own agent lives on localhost, and a hosted deployment must refuse exactly
 * that, so the answer depends on the deployment and the test suite needs to exercise both.
 */
export function parseAgentInput(
  input: unknown,
  allowPrivateHosts = false,
  /** Private addresses this deployment named as acceptable. Empty is the default posture. */
  allowedHosts: ReadonlySet<string> = new Set(),
): AgentInputParseResult {
  if (!isAgentInputObject(input)) {
    return { ok: false, error: "Agent input must be a JSON object." };
  }

  const name = boundedText(
    input.name,
    80,
    "Name must be text between 1 and 80 characters.",
  );
  if (typeof name !== "string") return name;

  const title = boundedText(
    input.title,
    120,
    "Title must be text between 1 and 120 characters.",
  );
  if (typeof title !== "string") return title;

  const roleDescription = boundedText(
    input.roleDescription,
    1000,
    "Role description must be text between 1 and 1000 characters.",
  );
  if (typeof roleDescription !== "string") return roleDescription;

  if (typeof input.visibility !== "string") {
    return { ok: false, error: "Visibility must be public or private." };
  }
  const visibility = input.visibility.trim();
  if (visibility !== "public" && visibility !== "private") {
    return { ok: false, error: "Visibility must be public or private." };
  }

  // The endpoint is optional and checked. Absent means the Bot in the box, which is what most people
  // want on their first go. Present means this server will POST to an address a person chose, so it
  // goes through the same target check as navigation before it is allowed anywhere near the database.
  let endpoint: string | undefined;
  if (input.endpoint !== undefined && input.endpoint !== "") {
    const verdict = checkAgentEndpoint(input.endpoint, {
      allowPrivateHosts,
      allowedHosts,
    });
    if (!verdict.allowed) return { ok: false, error: verdict.reason };
    endpoint = verdict.url;
  }

  // The key is optional and write-only. An absent field leaves an existing key alone; sending one
  // replaces it. There is no way to read one back, here or anywhere.
  let auth: { header: string; value: string } | undefined;
  if (input.auth !== undefined && input.auth !== null) {
    const supplied = input.auth as { header?: unknown; value?: unknown };
    const value =
      typeof supplied.value === "string" ? supplied.value.trim() : "";
    if (value) {
      const header =
        typeof supplied.header === "string" && supplied.header.trim()
          ? supplied.header.trim()
          : "Authorization";
      if (!/^[A-Za-z0-9-]+$/.test(header)) {
        return { ok: false, error: "That is not a valid header name." };
      }
      auth = { header, value };
    }
  }

  return {
    ok: true,
    value: { name, title, roleDescription, visibility, endpoint, auth },
  };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id would fail the constraint and
 * lose the row entirely. Who it was is in the payload either way.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

export function createAgentRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Whether this deployment may talk to its own network. True on a laptop, false when hosted. */
  allowPrivateHosts = false,
  /** Where a Bot's own refusal is recorded. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
  /**
   * Private addresses this deployment named as acceptable for an agent to live at.
   *
   * Separate from `allowPrivateHosts` on purpose: that one opens the network, this one opens an
   * address. A hosted deployment sets this and leaves the other off.
   */
  allowedHosts: ReadonlySet<string> = new Set(),
  /**
   * Which Bots a Bot may hand work to, for the screen that grants it.
   *
   * A named object rather than another positional argument: every parameter above this one is
   * optional, so a misplaced one typechecks and silently does nothing, and this list is already at
   * the length where that stops being hypothetical.
   *
   * Absent in a deployment with no plugin store, which is a deployment where no Bot may address any
   * other. The screen is then told the capability is off rather than shown a control that grants
   * nothing.
   */
  handoff?: {
    /** Whether the deployment's own caps leave the capability switched on at all. */
    enabled: boolean;
    /** The Bots this one may address today, read per call so a revoked grant stops showing. */
    reachableFrom: (agentId: string) => Promise<readonly string[]>;
    /**
     * Whether this Bot can be a grantee at all — the handing-on tool executes inside this
     * deployment's own run loop, so only a Bot that runs in it can be offered one. Exposed so the
     * screen can say that once, instead of letting every switch fail with the same refusal.
     * Optional so a caller without a plugin store answers "no" rather than crashing the read.
     */
    runsHere?: (agentId: string) => Promise<boolean | undefined>;
  },
  /**
   * Whether a coworker can run on this deployment's own Bot, i.e. be created with no endpoint.
   *
   * The store already refuses such a create on a deployment with no managed Bot; this exists so a
   * screen can say so before somebody fills in three steps of a form that was always going to fail.
   */
  builtInAvailable = false,
  /**
   * The managed Bot's own address, so a coworker created without an endpoint can be told apart.
   *
   * Creation bakes this address into the coworker's stored configuration, and afterwards nothing in
   * the row says whether a person supplied it. The difference matters to exactly one screen: a
   * coworker running here calls tools back with the deployment's own credential and needs no setup,
   * while one a person hosts needs a callback token put into their process. Without this flag the
   * dialog nagged built-in coworkers about a credential they never needed.
   */
  managedEndpoint?: string,
) {
  /** The dto with the one fact only this closure knows: whether the coworker runs on our own Bot. */
  const dto = (actor: AgentActor, agent: AgentProfile) => ({
    ...agentDto(actor, agent),
    // A string comparison on purpose: two absent values must not read as "runs on our Bot".
    builtIn:
      typeof agent.endpoint === "string" && agent.endpoint === managedEndpoint,
  });
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The Bot declined something, and says so.
   *
   * The audit trail records what a Bot did, decided by the gateway on the way to an action. A model
   * that refuses before calling any tool takes no action, so this records the attempted request.
   *
   * Self-reported, and said so in the row. The Bot calls this because its tool description tells it
   * to, so a model that declines without a tool call still writes nothing. This is evidence, not enforcement:
   * nothing is prevented by it, and a reader must not mistake an empty list for an untroubled Bot.
   */
  routes.post("/:agentId/declined", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await context.req.json().catch(() => null)) as {
      reason?: unknown;
      request?: unknown;
    } | null;

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return context.json({ error: "A reason is required." }, 400);
    }

    if (auditStore) {
      const actor = context.var.actor;
      await recordAuditEvent(auditStore, {
        eventType: "bot.declined",
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId,
          actor: actor?.email ?? "unknown",
          reason: reason.slice(0, 500),
          // What it was asked, in the Bot's own words and only if it offered them. Truncated for the
          // same reason every other payload here is: a trail is not a transcript.
          ...(typeof body?.request === "string" && body.request.trim()
            ? { request: body.request.trim().slice(0, 500) }
            : {}),
          reportedBy: "the Bot itself",
        },
      });
    }

    return context.json({ recorded: true });
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const hidden = context.req.query("hidden") === "true";
      const agents = await store.list(context.var.actor, hidden);
      return context.json({
        agents: agents.map((agent) => dto(context.var.actor, agent)),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put(
    "/:agentId/avatar",
    requireUser,
    bodyLimit({
      maxSize: 3 * 1024 * 1024,
      onError: (context) =>
        context.json({ error: "Avatar image must be 2 MB or smaller." }, 413),
    }),
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as {
        image?: unknown;
      } | null;
      const parsed = parseAvatarImage(body?.image);
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);

      try {
        const agent = await store.setAvatar(
          context.var.actor,
          context.req.param("agentId"),
          parsed.value,
        );
        return context.json({ agent: dto(context.var.actor, agent) });
      } catch (error) {
        return mapStoreError(context, error);
      }
    },
  );

  routes.get("/:agentId/avatar/image", requireUser, async (context) => {
    try {
      const image = await store.avatar(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!image) {
        return context.json({ error: "Avatar not found." }, 404);
      }
      return avatarResponse(image);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * What kinds of coworker this deployment can create, for the screen that asks.
   *
   * Static per process: whether a managed Bot exists is deployment configuration, not data. Above
   * the parameterised route on purpose, so "capabilities" can never be read as an agent id.
   */
  routes.get("/capabilities", requireUser, (context) =>
    context.json({ capabilities: { builtInAvailable } }),
  );

  routes.get("/:agentId", requireUser, async (context) => {
    try {
      const agent = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!agent) {
        return context.json({ error: "Agent not found." }, 404);
      }
      return context.json({ agent: dto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Try an endpoint before saving it.
   *
   * Deliberately not part of create: a person needs to know whether their agent answers before they
   * commit to it, and they need to be able to try again without creating dead
   * Bots on the way. It runs the same target check as saving, so it cannot probe addresses that
   * registration would refuse.
   */
  routes.post("/test-connection", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      endpoint?: unknown;
      headers?: unknown;
    } | null;
    const headers =
      body?.headers && typeof body.headers === "object"
        ? (body.headers as Record<string, string>)
        : undefined;
    const result = await testAgentConnection(body?.endpoint, {
      headers,
      allowPrivateHosts,
      allowedHosts,
    });
    // 200 either way: the request succeeded, and the verdict is the payload. A failed connection test
    // is an answer, not an error, and a 4xx here would have the surface render it as a broken button.
    return context.json(result);
  });

  /**
   * Record something that changed a Bot.
   *
   * One helper rather than eight copies, because the eight routes below all answer the same question
   * and the payload has to be the same shape for a reader filtering the trail.
   *
   * Never fatal. The change is already made and the caller has been told so; a trail that is briefly
   * unavailable is not a reason to report a failure that did not happen.
   */
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: Extract<AuditEventType, `bot.${string}`>,
    agentId: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: { bot: agentId, actor: actor?.email ?? "unknown", ...payload },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  routes.post("/", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(
      await context.req.json().catch(() => null),
      allowPrivateHosts,
      allowedHosts,
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const agent = await store.create(context.var.actor, parsed.value);
      /*
       * The endpoint, because that is where conversation content will be sent, and whether a key was
       * attached, because "this Bot authenticates" is a fact and the key itself never is.
       */
      await record(context, "bot.created", agent.id, {
        name: parsed.value.name,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        hasKey: Boolean(parsed.value.auth),
      });
      return context.json({ agent: dto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.patch("/:agentId", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(
      await context.req.json().catch(() => null),
      allowPrivateHosts,
      allowedHosts,
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const agent = await store.update(
        context.var.actor,
        context.req.param("agentId"),
        parsed.value,
      );
      // What changed, not the new values. Repointing the endpoint is the dangerous edit and is worth
      // naming; a replaced key is worth knowing about and is never worth recording.
      await record(context, "bot.updated", agent.id, {
        name: parsed.value.name,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        ...(parsed.value.auth ? { keyReplaced: true } : {}),
      });
      return context.json({ agent: dto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/duplicate", requireUser, async (context) => {
    try {
      const agent = await store.duplicate(
        context.var.actor,
        context.req.param("agentId"),
      );
      // Recorded against the copy, naming the original: a duplicate inherits an endpoint, so the
      // reader needs to know a second Bot now points at it.
      await record(context, "bot.duplicated", agent.id, {
        copiedFrom: context.req.param("agentId"),
      });
      return context.json({ agent: dto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/hide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.hidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unhide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unhidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Issue this agent its callback credential, and show it once.
   *
   * A POST because it writes and because it replaces: calling it again rotates, which is how a leaked
   * token is retired. The token is in the response and nowhere else, ever again, and it is not written
   * to the audit payload either: a trail that records credentials is a credential store with worse
   * access control.
   */
  routes.post("/:agentId/callback-token", requireUser, async (context) => {
    try {
      const token = await store.issueCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      // That one was issued, never what it is. A trail that records credentials is a credential
      // store with worse access control.
      await record(
        context,
        "bot.callback_token_issued",
        context.req.param("agentId"),
      );
      return context.json({ token }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /** Take it away. The agent may still hold a conversation; it may not reach anything outside one. */
  routes.delete("/:agentId/callback-token", requireUser, async (context) => {
    try {
      await store.revokeCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      await record(
        context,
        "bot.callback_token_revoked",
        context.req.param("agentId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:agentId", requireUser, async (context) => {
    try {
      await store.softDelete(context.var.actor, context.req.param("agentId"));
      await record(context, "bot.deleted", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Which Bots this Bot may hand work to.
   *
   * On the Bot's own screen rather than under the connector catalogue, because it is a fact about
   * this Bot and not about a vendor: the catalogue's entries have a fixed list of tools, and the
   * Bots a deployment has are whatever somebody made.
   *
   * `enabled` is reported separately from the grants, because the two fail differently. A grant with
   * the capability switched off is a row in the database that will never be read, and a screen that
   * offered it without saying so would be a switch wired to nothing.
   */
  routes.get("/:agentId/handoff", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    try {
      // Asked of the store, so a Bot somebody may not see is "not found" here as everywhere else,
      // rather than a list of who it can reach.
      const agent = await store.get(context.var.actor, agentId);
      if (!agent) return context.json({ error: "Agent not found." }, 404);
      return context.json({
        handoff: {
          enabled: handoff?.enabled ?? false,
          // Granting is an administrator's, the same as it is on every other grant.
          canGrant: context.var.actor.role === "admin",
          reachable: handoff ? await handoff.reachableFrom(agentId) : [],
          // Whether this Bot can hold such a grant at all; the write path refuses one that cannot,
          // and the screen should say so before a person flips switches that can only bounce.
          grantable: handoff?.runsHere
            ? ((await handoff.runsHere(agentId)) ?? false)
            : false,
        },
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function boundedText(
  value: unknown,
  maximumLength: number,
  error: string,
): string | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error };
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : { ok: false, error };
}

function agentDto(actor: AgentActor, agent: AgentProfile) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    roleDescription: agent.roleDescription,
    avatarSeed: agent.avatarSeed,
    avatarUrl: avatarUrl(
      `/api/agents/${encodeURIComponent(agent.id)}/avatar/image`,
      agent.hasCustomAvatar ? agent.avatarUpdatedAt : null,
    ),
    visibility: agent.visibility,
    hidden: agent.hidden,
    systemOwned: agent.systemOwned,
    // Published so the edit form can show it. Safe to expose: it is an address the person supplied,
    // and any credential for it lives in the vault, never in this row.
    endpoint: agent.endpoint,
    hasAuth: agent.hasAuth,
    // Whether one exists, never what it is.
    hasCallbackToken: agent.hasCallbackToken,
    canManage: canManageAgent(actor, agent),
    canCustomizeAvatar: canCustomizeAgentAvatar(actor, agent),
    // Ownership, kept separate from permission. `canManage` is also true for an administrator on
    // another user's coworker, so a roster that split "mine" on it would file other people's work
    // under yours, and only for administrators, who are the least likely to notice.
    mine: agent.ownerUserId === actor.id,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json(
      { error: "You do not have permission to manage this agent." },
      403,
    );
  }
  if (error instanceof ProtectedAgentError) {
    return context.json({ error: "System-owned agents are protected." }, 403);
  }
  if (error instanceof ManagedAgentUnavailableError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
