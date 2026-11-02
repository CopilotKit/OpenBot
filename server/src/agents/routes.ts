import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { afterExposureChange } from "../plugins/exposure-change";
import type { SharedUseStore } from "../plugins/shared-use-store";
import { testAgentConnection } from "./connection-test";
import { checkAgentEndpoint } from "./endpoint";
import { isolationState, mayIsolate } from "./isolation";
import { isManagedEndpoint } from "./managed-endpoint";
import { canManageAgent } from "./profile-policy";
import {
  AgentAssignedError,
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  IsolationRefusedError,
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
  isolated?: unknown;
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

  if (typeof input.title !== "string" || input.title.trim().length > 120) {
    return {
      ok: false,
      error: "Title must be text of 120 characters or fewer.",
    };
  }
  const title = input.title.trim();

  const roleDescription = boundedText(
    input.roleDescription,
    1000,
    "What it does must be text between 1 and 1000 characters.",
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
      // Refused here rather than discovered on the first run. This value is encrypted and stored,
      // and then sent as a header on every turn the Bot takes; one that cannot be a header value
      // throws inside `fetch` every one of those times, long after the form said it was saved.
      const unsendable = unsendableHeaderValue(value);
      if (unsendable) {
        return {
          ok: false,
          error: `That key contains ${unsendable}, so it cannot be sent as a header.`,
        };
      }
      auth = { header, value };
    }
  }

  // Absent is "leave it as it is", so only a present value is checked. A string "true" is refused
  // rather than read as yes: this decides which computer a Bot runs on.
  if (input.isolated !== undefined && typeof input.isolated !== "boolean") {
    return { ok: false, error: "Isolated must be true or false." };
  }
  const isolated = input.isolated;

  return {
    ok: true,
    value: {
      name,
      title,
      roleDescription,
      visibility,
      endpoint,
      auth,
      ...(isolated === undefined ? {} : { isolated }),
    },
  };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * What in this value stops it being a header, or null when nothing does.
 *
 * `new Headers()` refuses a line break, a NUL, and any code point above U+00FF, and it refuses them
 * by throwing a TypeError from inside `fetch` — which is not a decision this deployment gets to
 * take part in. Both surfaces below take a header value from the same box on the same form and
 * neither looked, so the throw arrived somewhere that reads as something else entirely: on the
 * connection test it lands in the catch written for a dead host, and the person is told "this server
 * could not reach that address", which sends them to their tunnel and their firewall over a key
 * they had just pasted with a wrapped line in it. A hyphen a document turned into an en dash does
 * the same thing, and looks like nothing at all in a password box.
 *
 * The description never contains the value. This is asked of a credential on one of the two paths,
 * and one character of a secret in an error message is one character too many.
 */
function unsendableHeaderValue(value: string): string | null {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d) return "a line break";
    if (code === 0) return "a null character";
    if (code > 0xff) return "a character that cannot go in a header value";
  }
  return null;
}

/**
 * Parse and validate the headers a person attaches to a connection test.
 *
 * Unvalidated, the route cast any object straight into the probe `fetch`, so an array value, a
 * nested object, or a `__proto__` key travelled into the network call and threw a TypeError 500 —
 * or probed header handling the deployment never meant to exercise. Names follow the same rule as
 * the stored agent auth header; values must be strings; the whole map is capped so a pasted dump
 * cannot balloon the probe.
 */
export function parseConnectionHeaders(
  input: unknown,
):
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Headers must be an object of name to value." };
  }
  /*
   * A JSON body carrying `__proto__` does not arrive as an own property: `JSON.parse` sets the
   * object's prototype instead, so `Object.entries` never sees it and a name block-list below
   * would pass it straight through into the probe fetch. Refuse any headers object whose prototype
   * is not a plain one before reading entries.
   */
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    return { ok: false, error: "Headers must be an object of name to value." };
  }
  const entries = Object.entries(input);
  if (entries.length > 32) {
    return { ok: false, error: "Headers must have at most 32 entries." };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      name === "__proto__" ||
      name === "constructor" ||
      name === "prototype" ||
      !/^[A-Za-z0-9-]+$/.test(name) ||
      name.length > 64
    ) {
      return {
        ok: false,
        error: `That is not a valid header name: ${name.slice(0, 64)}.`,
      };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `Header "${name}" must be a string value.`,
      };
    }
    if (value.length > 4096) {
      return {
        ok: false,
        error: `Header "${name}" must be at most 4096 characters.`,
      };
    }
    const unsendable = unsendableHeaderValue(value);
    if (unsendable) {
      return {
        ok: false,
        error: `Header "${name}" contains ${unsendable}, so it cannot be sent.`,
      };
    }
    headers[name] = value;
  }
  return { ok: true, value: entries.length === 0 ? undefined : headers };
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
     * Whether this Bot can be a grantee at all: any Bot that exists, built in or at its own
     * endpoint, since both reach the same handoff desk. Optional so a caller without a plugin store
     * answers "no" rather than crashing the read.
     */
    canHandOn?: (agentId: string) => Promise<boolean | undefined>;
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
  /**
   * Where a Bot's shared accounts live, so making a Bot public can say what that means for them.
   *
   * Absent in a deployment with no plugin store, which is a deployment where `afterExposureChange`
   * already reports nothing rather than reach for a store that is not there.
   */
  sharedUse?: SharedUseStore,
  /**
   * The deployment's own token and the addresses it belongs to, so a connection test against one of
   * them knocks the way a real run will.
   *
   * A named object rather than two more positional strings, for the reason the handoff parameter
   * gives: everything above it is optional, and a misplaced string typechecks.
   *
   * `endpoints` is every address this deployment runs — the Bot in the box and any harness picked
   * during setup — because the run path had to learn that same lesson: matching only the first left
   * the picked harness answering 401 to everything.
   */
  managedRun?: { token: string; endpoints: readonly (string | URL)[] },
  /**
   * Whether this deployment can give one Bot a computer of its own (`deploymentCanIsolate`).
   *
   * Absent is no: a deployment that never said it can make a second computer is not trusted to.
   */
  isolation?: { available: boolean },
) {
  const isolationAvailable = isolation?.available ?? false;
  /** The dto with the one fact only this closure knows: whether the coworker runs on our own Bot. */
  const dto = (actor: AgentActor, agent: AgentProfile) => ({
    ...agentDto(actor, agent),
    // A string comparison on purpose: two absent values must not read as "runs on our Bot".
    builtIn:
      typeof agent.endpoint === "string" && agent.endpoint === managedEndpoint,
  });
  /**
   * The dtos, each with whether its computer of its own is in effect now.
   *
   * Asked of the OWNER's switch, read now, so an administrator withdrawing "Isolated Bots" shows on
   * the Bot's page at its next load without anybody editing the Bot. Read once per owner and one
   * owner at a time, and only for Bots that asked: a roster is mostly people's own Bots, and most of
   * those are not isolated.
   */
  const dtos = async (actor: AgentActor, list: readonly AgentProfile[]) => {
    const owners = new Map<string, boolean>();
    for (const agent of list) {
      if (!agent.isolated || !agent.ownerUserId) continue;
      if (owners.has(agent.ownerUserId)) continue;
      owners.set(agent.ownerUserId, await mayIsolate(agent.ownerUserId));
    }
    return list.map((agent) => ({
      ...dto(actor, agent),
      ...isolationState(
        agent,
        isolationAvailable,
        agent.ownerUserId ? (owners.get(agent.ownerUserId) ?? false) : false,
      ),
    }));
  };
  const dtoOf = async (actor: AgentActor, agent: AgentProfile) =>
    (await dtos(actor, [agent]))[0];
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

    /*
     * The same question every other route here asks first: is this a Bot the caller may reach?
     *
     * The row says "reportedBy: the Bot itself", and the Bot reports through the person's session,
     * so the trail's only way of knowing the report came from a Bot is that the person could have
     * been talking to that Bot. Without this check, any signed-in person could write a decline
     * against any id at all, a coworker they cannot see included, and an administrator reading the
     * trail would take it for something the Bot said. Not found rather than forbidden, as the store
     * answers everywhere else, so the check does not confirm which ids exist.
     */
    const agent = await store.get(context.var.actor, agentId);
    if (!agent) {
      return context.json({ error: "Couldn't find that Bot." }, 404);
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
        agents: await dtos(context.var.actor, agents),
      });
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
    context.json({
      capabilities: {
        builtInAvailable,
        // Whether this person may tick it is a switch, read from `/api/admin/enterprise/me`.
        isolationAvailable,
      },
    }),
  );

  routes.get("/:agentId", requireUser, async (context) => {
    // A whitespace id would reach the store query and answer 500 on some backends instead of a
    // 400 for a malformed call. Existence stays a 404; shape is checked here.
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agent = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!agent) {
        return context.json({ error: "Couldn't find that Bot." }, 404);
      }
      return context.json({ agent: await dtoOf(context.var.actor, agent) });
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
    const parsed = parseConnectionHeaders(body?.headers);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    /*
     * An address this deployment runs is knocked on with this deployment's token.
     *
     * Nobody types that token — the run path attaches it by recognising the address — so a test
     * that left it off reported "The agent refused this request. If it needs a key, add it as a
     * header." for the Bot in the box and for the harness picked during setup. Both work; the
     * advice was to break them.
     *
     * The person's own headers are applied over these rather than under, because a header they
     * typed is a thing they can see and change, and this one is not.
     */
    const ours =
      managedRun &&
      typeof body?.endpoint === "string" &&
      isManagedEndpoint(body.endpoint, managedRun.endpoints);
    const headers = {
      ...(ours ? { "x-openbot-agent-token": managedRun.token } : {}),
      ...parsed.value,
    };
    const result = await testAgentConnection(body?.endpoint, {
      // Absent rather than empty when there is nothing to send, so a deployment with no managed Bot
      // probes exactly as it did before this.
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
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
    /** Undefined only for a Bot that was refused before it existed. */
    agentId: string | undefined,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        ...(agentId ? { targetId: agentId } : {}),
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId ?? null,
          actor: actor?.email ?? "unknown",
          ...payload,
        },
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

  /**
   * A computer of its own, asked for and refused, on the trail and in the answer.
   *
   * Recorded because nothing else would be: the Bot is unchanged, or was never made, so the row is
   * the only evidence of the attempt. Against the Bot it was asked for, or against no Bot on a create.
   * The answer has the shape the enterprise gate gives a refused capability, so a screen reads both
   * the same way.
   */
  const refuseIsolation = async (
    context: Context<{ Variables: AppVariables }>,
    reason: "capability" | "unowned" | "deployment",
    message: string,
    agentId: string | undefined,
    name: string,
  ): Promise<Response> => {
    await record(context, "bot.isolation_refused", agentId, {
      reason,
      name,
      ...(agentId ? {} : { attempted: "create" }),
    });
    return context.json(
      {
        error: message,
        ...(reason === "capability" ? { capability: "isolatedComputers" } : {}),
      },
      reason === "deployment" ? 400 : 403,
    );
  };
  /** Said where a deployment's computers cannot make one more. */
  const NO_ISOLATION =
    "This OpenBot can't give a Bot a computer of its own, so it runs on yours.";

  routes.post("/", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(
      await context.req.json().catch(() => null),
      allowPrivateHosts,
      allowedHosts,
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    if (parsed.value.isolated === true && !isolationAvailable) {
      return refuseIsolation(
        context,
        "deployment",
        NO_ISOLATION,
        undefined,
        parsed.value.name,
      );
    }

    try {
      /*
       * A coworker with no address runs here, on the text this form already requires.
       *
       * "Agent endpoint (optional)" was not optional on the recommended one-container image: with
       * nothing to bind to, `create` refused with "This deployment has no managed Bot", so a person
       * could not make a coworker at all on the image the README tells them to deploy. The role
       * description is what such a coworker runs on — the same field a `built_in` Bot in the tenant
       * package carries, for the same purpose — and passing it only when no endpoint was given keeps
       * every other path exactly as it was: give an address and it is a remote Bot, as before.
       */
      const agent = await store.create(context.var.actor, {
        ...parsed.value,
        ...(parsed.value.endpoint
          ? {}
          : { systemPrompt: parsed.value.roleDescription }),
      });
      /*
       * The endpoint, because that is where conversation content will be sent, and whether a key was
       * attached, because "this Bot authenticates" is a fact and the key itself never is.
       *
       * And who may reach it. `visibility` is not a display preference: `accessFilter` admits a
       * `public` coworker to every signed-in person, and `canRunAgent` is `canAccessAgent`, so public
       * means everybody in the deployment may act as this Bot and spend the grants it holds. A row
       * that cannot say which it was cannot reconstruct who could use this coworker at the time.
       */
      await record(context, "bot.created", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        hasKey: Boolean(parsed.value.auth),
        // Which computer it runs on is who it can reach, so a computer of its own is worth naming.
        ...(parsed.value.isolated ? { isolated: true } : {}),
      });
      return context.json(
        { agent: await dtoOf(context.var.actor, agent) },
        201,
      );
    } catch (error) {
      if (error instanceof IsolationRefusedError) {
        return refuseIsolation(
          context,
          error.reason,
          error.message,
          undefined,
          parsed.value.name,
        );
      }
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
    if (parsed.value.isolated === true && !isolationAvailable) {
      return refuseIsolation(
        context,
        "deployment",
        NO_ISOLATION,
        context.req.param("agentId"),
        parsed.value.name,
      );
    }

    try {
      const agent = await store.update(
        context.var.actor,
        context.req.param("agentId"),
        parsed.value,
      );
      /*
       * What changed, not the new values. Repointing the endpoint is the dangerous edit and is worth
       * naming; a replaced key is worth knowing about and is never worth recording.
       *
       * `visibility` is carried the way `name` is — on every row, whether or not this edit moved it —
       * because it is the second dangerous edit and the route has no before to compare against.
       * Public admits every signed-in person to this coworker, and `canRunAgent` is `canAccessAgent`,
       * so it hands them the right to act as it and spend what it was granted. Without the value on
       * each row, an edit that opened a coworker to the whole deployment is byte-identical to one
       * that corrected its title, and the trail cannot say when it was opened or by whom. Recorded on
       * every row rather than only on the row that changed it, so reading the trail forward tells you
       * what was reachable at any point, which is what an incident asks.
       */
      await record(context, "bot.updated", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        ...(parsed.value.auth ? { keyReplaced: true } : {}),
        // Only when the edit said, since absent leaves it as it was and the route has no before.
        ...(parsed.value.isolated === undefined
          ? {}
          : { isolated: parsed.value.isolated }),
      });
      /*
       * Publishing is the owner's call, and a wider audience can outrun what an administrator
       * approved for a shared account this Bot holds. Reported only on the edit that opens a Bot to
       * everybody, so a screen can offer to ask rather than let the first refused call be how anybody
       * finds out.
       */
      return context.json({
        agent: await dtoOf(context.var.actor, agent),
        ...(parsed.value.visibility === "public"
          ? {
              sharedApps: await afterExposureChange(
                sharedUse,
                context.var.actor,
                agent.id,
              ),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof IsolationRefusedError) {
        return refuseIsolation(
          context,
          error.reason,
          error.message,
          context.req.param("agentId"),
          parsed.value.name,
        );
      }
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/duplicate", requireUser, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agent = await store.duplicate(
        context.var.actor,
        context.req.param("agentId"),
      );
      // Recorded against the copy, naming the original: a duplicate inherits an endpoint, so the
      // reader needs to know a second Bot now points at it.
      await record(context, "bot.duplicated", agent.id, {
        copiedFrom: context.req.param("agentId"),
        // Kept only when the person duplicating may give it a computer of its own.
        ...(agent.isolated ? { isolated: true } : {}),
      });
      return context.json(
        { agent: await dtoOf(context.var.actor, agent) },
        201,
      );
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

  routes.post("/:agentId/pin", requireUser, async (context) => {
    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.pinned", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unpin", requireUser, async (context) => {
    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unpinned", context.req.param("agentId"));
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
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
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
    if (!agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      // Asked of the store, so a Bot somebody may not see is "not found" here as everywhere else,
      // rather than a list of who it can reach.
      const agent = await store.get(context.var.actor, agentId);
      if (!agent)
        return context.json({ error: "Couldn't find that Bot." }, 404);
      return context.json({
        handoff: {
          enabled: handoff?.enabled ?? false,
          // Granting is an administrator's, the same as it is on every other grant.
          canGrant: context.var.actor.role === "admin",
          reachable: handoff ? await handoff.reachableFrom(agentId) : [],
          // Whether this Bot can hold such a grant at all; the write path refuses one that cannot,
          // and the screen should say so before a person flips switches that can only bounce.
          grantable: handoff?.canHandOn
            ? ((await handoff.canHandOn(agentId)) ?? false)
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
    visibility: agent.visibility,
    hidden: agent.hidden,
    pinned: agent.pinned,
    systemOwned: agent.systemOwned,
    // Published so the edit form can show it. Safe to expose: it is an address the person supplied,
    // and any credential for it lives in the vault, never in this row.
    endpoint: agent.endpoint,
    hasAuth: agent.hasAuth,
    // Whether one exists, never what it is.
    hasCallbackToken: agent.hasCallbackToken,
    // What the owner asked for. Whether it is in effect is `isolationActive`, added by the route.
    isolated: agent.isolated,
    canManage: canManageAgent(actor, agent),
    // Ownership, kept separate from permission. `canManage` is also true for an administrator on
    // another user's coworker, so a roster that split "mine" on it would file other people's work
    // under yours, and only for administrators, who are the least likely to notice.
    mine: agent.ownerUserId === actor.id,
    assignedToMe: agent.assignedToMe ?? false,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Couldn't find that Bot." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json({ error: "You can't manage this Bot." }, 403);
  }
  if (error instanceof ProtectedAgentError) {
    return context.json(
      { error: "This Bot is built in and can't be changed." },
      403,
    );
  }
  if (error instanceof ManagedAgentUnavailableError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof AgentAssignedError) {
    return context.json({ error: error.message }, 409);
  }
  // Every route that can raise this records it first; this is the answer for any that is added later.
  if (error instanceof IsolationRefusedError) {
    return context.json(
      {
        error: error.message,
        ...(error.reason === "capability"
          ? { capability: "isolatedComputers" }
          : {}),
      },
      403,
    );
  }
  throw error;
}
