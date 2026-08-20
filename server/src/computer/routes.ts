import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "./gateway";
import { type PolicyStore, parseActionPolicy } from "./policy-store";

/**
 * The Bot computer's surface, behind the same session guard as every other API route.
 *
 * The computer has token authentication but no user/session identity. These server routes require a
 * session guard because `COMPUTER_TOKEN` proves the caller is an internal service, not which user is
 * asking to drive the browser.
 *
 * Every computer call goes through the gateway. That is the governance seam: each acting route in
 * this file passes through a policy decision and audit row before it reaches the computer.
 */
export function createComputerRoutes(
  gateway: ComputerGateway,
  policyStore: PolicyStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:botId/status", requireUser, async (context) => {
    const botId = context.req.param("botId");
    return context.json(await gateway.status(botId));
  });

  routes.get("/:botId/screenshot", requireUser, async (context) => {
    try {
      return context.json(await gateway.screenshot(context.req.param("botId")));
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  routes.get("/:botId/read", requireUser, async (context) => {
    try {
      return context.json(await gateway.read(context.req.param("botId")));
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  routes.post("/:botId/navigate", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      url?: unknown;
    } | null;
    if (typeof body?.url !== "string" || !body.url.trim()) {
      return context.json({ error: "A web address is required." }, 400);
    }

    try {
      return context.json(
        await gateway.navigate(
          context.req.param("botId") ?? "default",
          {
            id: context.var.actor.id,
            ...(context.var.actor.email === DEV_ACTOR_EMAIL
              ? {}
              : { userId: context.var.actor.id }),
          },
          body.url.trim(),
        ),
      );
    } catch (error) {
      if (error instanceof ActionRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      // A refusal is the rules working, not a fault, so it is a 403 with the reason a person reads.
      // Collapsing it into the same 5xx as an unreachable computer would send somebody looking for
      // an outage that is not happening.
      if (error instanceof NavigationRefusedError) {
        return context.json({ error: error.message }, 403);
      }
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  routes.post("/:botId/snapshot", requireUser, async (context) => {
    try {
      return context.json(await gateway.snapshot(context.req.param("botId")));
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  /**
   * The acting routes.
   *
   * Each one hands the gateway the Bot, the actor and the input, and does no checking
   * of its own beyond the shape of the request. Where a decision gets made is a single place.
   */
  routes.post("/:botId/click", requireUser, (context) =>
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      return gateway.click(botId, actor, ref, signal);
    }),
  );

  routes.post("/:botId/type", requireUser, (context) =>
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      if (typeof body?.text !== "string") {
        return { error: "The text to enter is required." };
      }
      return gateway.type(
        botId,
        actor,
        {
          ...ref,
          text: body.text,
          submit: body?.submit === true,
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/key", requireUser, (context) =>
    act(context, (botId, actor, body, signal) => {
      if (typeof body?.key !== "string" || !body.key) {
        return { error: "A key name is required, such as Enter or Tab." };
      }
      const ref = asRef(body);
      return gateway.key(
        botId,
        actor,
        {
          key: body.key,
          ...(ref ?? {}),
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/scroll", requireUser, (context) =>
    act(context, (botId, actor, body) =>
      gateway.scroll(botId, actor, {
        ...(typeof body?.deltaY === "number" ? { deltaY: body.deltaY } : {}),
      }),
    ),
  );

  /**
   * Who has the wheel. Polled by the surface next to the screen, so the person sees the Bot ask for
   * help without reloading anything.
   */
  routes.get("/:botId/control", requireUser, async (context) => {
    try {
      return context.json(await gateway.control(context.req.param("botId")));
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  routes.post("/:botId/control/request", requireUser, (context) =>
    act(context, (botId, actor, body) =>
      gateway.requestHelp(
        botId,
        actor,
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "The assistant needs a person to continue.",
      ),
    ),
  );

  /**
   * The computers, for the admin surface.
   *
   * Not per-Bot in the path the way the acting routes are: this asks the computer what it holds, and
   * it holds a list. `:botId` is still there because every route under this router has it and the
   * gateway wants somebody to attribute the call to.
   */
  routes.get("/:botId/computers", requireUser, async (context) => {
    try {
      return context.json(await gateway.computers());
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  /** Stop the browser, keep the logins. */
  routes.post("/:botId/computers/stop", requireUser, (context) =>
    act(context, (botId, actor) => gateway.stopComputer(botId, actor)),
  );

  /** Delete the profile. Every login goes with it, which is the point and also the danger. */
  routes.post("/:botId/computers/reset", requireUser, (context) =>
    act(context, (botId, actor) => gateway.resetComputer(botId, actor)),
  );

  routes.post("/:botId/control/take", requireUser, (context) =>
    act(context, (botId, actor) => gateway.takeControl(botId, actor)),
  );

  routes.post("/:botId/control/release", requireUser, (context) =>
    act(context, (botId, actor) => gateway.releaseControl(botId, actor)),
  );

  /** The Bot asking for a value it must not be told. */
  routes.post("/:botId/control/secret", requireUser, (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.ref !== "string" || !body.ref) {
        return {
          error:
            "Say which field the value goes in, using a ref from your snapshot.",
        };
      }
      if (typeof body?.snapshotId !== "number") {
        return { error: "The snapshotId the ref came from is required." };
      }
      return gateway.requestSecret(botId, actor, {
        label:
          typeof body?.label === "string" && body.label.trim()
            ? body.label.trim()
            : "the value this page is asking for",
        ref: body.ref,
        snapshotId: body.snapshotId,
      });
    }),
  );

  /**
   * A person supplying it.
   *
   * The value is read from the body, passed straight through, and referred to nowhere else. Its own
   * route rather than a `kind` on the input route below, so that grepping for where a secret can enter
   * this server returns exactly one place.
   */
  routes.post("/:botId/human/secret", requireUser, (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.text !== "string" || !body.text) {
        return { error: "A value is required." };
      }
      return gateway.supplySecret(botId, actor, body.text);
    }),
  );

  /**
   * A person's own mouse and keyboard.
   *
   * Not through the policy decision, and not audited per keystroke. See `ComputerGateway.humanInput`.
   * The takeover is the audited event; what the person typed during it is deliberately unrecorded,
   * because the reason a takeover exists is to let them enter the thing nothing else should keep.
   */
  routes.post("/:botId/human/:kind", requireUser, async (context) => {
    const kind = context.req.param("kind");
    if (
      kind !== "click" &&
      kind !== "type" &&
      kind !== "key" &&
      kind !== "scroll"
    ) {
      return context.json({ error: "Unknown input." }, 400);
    }
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    try {
      return context.json(
        await gateway.humanInput(context.req.param("botId"), {
          kind,
          ...(body ?? {}),
        } as Parameters<typeof gateway.humanInput>[1]),
      );
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  /** The Bot's files. Through the gateway, like every other acting call. */
  routes.post("/:botId/files/list", requireUser, (context) =>
    act(context, (botId, actor, body) =>
      gateway.listFiles(botId, actor, {
        ...(typeof body?.path === "string" && body.path.trim()
          ? { path: body.path.trim() }
          : {}),
      }),
    ),
  );

  routes.post("/:botId/files/read", requireUser, (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      return gateway.readFile(botId, actor, { path: body.path.trim() });
    }),
  );

  routes.post("/:botId/files/write", requireUser, (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      if (typeof body?.contents !== "string") {
        return { error: "The contents to write are required." };
      }
      return gateway.writeFile(botId, actor, {
        path: body.path.trim(),
        contents: body.contents,
        append: body.append === true,
      });
    }),
  );

  /**
   * The policy, readable and writable by an administrator.
   *
   * Here rather than in the admin routes file, because this directory owns the computer and `app.ts`
   * takes one appended line per mount. The storage underneath is durable, so administrator rules
   * remain active after a restart.
   */
  routes.get("/policy", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ policy: policyStore.get() });
  });

  routes.put("/policy", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const parsed = parseActionPolicy(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    try {
      await policyStore.set(parsed.policy, context.var.actor.email);
    } catch {
      /*
       * Saved, or said so. A boundary that is enforced now and gone after the next restart is worse
       * than one that was never set, so a policy that could not be written is reported as a failure
       * rather than quietly held in memory. Nothing changes: the previous policy is still in force.
       */
      return context.json(
        {
          error:
            "That rule could not be saved, so it has not been applied. The previous boundary is still in force.",
        },
        503,
      );
    }
    // Echoed back so a caller can see exactly what is now in force rather than assuming its request
    // was stored verbatim.
    return context.json({ policy: policyStore.get() });
  });

  return routes;
}

type ComputerContext = Context<{ Variables: AppVariables }>;

/** A request that was rejected before any decision was needed, because it was not a valid action. */
type BadRequest = { error: string };

const badRef: BadRequest = {
  error:
    "A ref and the snapshotId it came from are both required. Take a snapshot first.",
};

/**
 * Shared plumbing for acting routes that use this helper: resolve who is asking, run, and map
 * failures onto statuses.
 *
 * One place, so a new acting route cannot accidentally report a policy refusal as a server error, and
 * so the actor is derived the same way every time.
 */
async function act(
  context: ComputerContext,
  handler: (
    botId: string,
    actor: ActionActor,
    body: Record<string, unknown> | null,
    /**
     * The person's Stop, as an abort.
     *
     * The surface aborts its request when Stop is pressed; Bun exposes that here, and every acting
     * route passes it on so the abort reaches the Playwright call mid-click. Without it, Stop ended
     * the run in the transcript while the click carried on landing on a live page, harmless most of
     * the time, and not harmless on a Confirm button, which is exactly when Stop gets pressed.
     */
    signal: AbortSignal,
  ) => Promise<unknown> | BadRequest,
) {
  // Always present on these routes, which all declare `:botId`. The fallback exists because this
  // helper is typed against a generic context that cannot know that, and a thrown "undefined bot"
  // would be a worse outcome than naming the one shared computer.
  const botId = context.req.param("botId") ?? "default";
  const record = context.var.actor;
  const body = (await context.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const result = await handler(
      botId,
      {
        id: record.id,
        // Only a real users row may go in the audit table's foreign key column. The local development
        // actor is not one, so writing it there fails the constraint and loses the row entirely. Who
        // it was is recorded in the payload regardless. See gateway.ts.
        ...(record.email === DEV_ACTOR_EMAIL ? {} : { userId: record.id }),
      },
      body,
      context.req.raw.signal,
    );
    if (isBadRequest(result)) {
      return context.json(result, 400);
    }
    return context.json(result as Record<string, unknown>);
  } catch (error) {
    // A policy refusal is the product working. 403 with the rule that refused it, so the surface can
    // tell the person which boundary they met rather than reporting a malfunction.
    if (error instanceof ActionRefusedError) {
      return context.json({ error: error.message, rule: error.rule }, 403);
    }
    // The computer refused the path itself, which is a different thing from the policy refusing this
    // Bot. Same status, no rule attached, because there is no rule to go and edit.
    if (error instanceof WorkspaceRefusedError) {
      return context.json({ error: error.message }, 403);
    }
    // A 400, deliberately, NOT a 403. The surface treats 403 as "a boundary refused you" and renders
    // it as Blocked, so returning it for "there is no file at notes.md" told both the person and the
    // model that a policy had intervened when none had.
    if (error instanceof WorkspaceRequestError) {
      return context.json({ error: error.message }, 400);
    }
    return context.json({ error: describe(error) }, statusFor(error));
  }
}

/**
 * The local actor's address, matched to decide whether the id is a real users row.
 *
 * Compared against rather than imported from `auth/dev-actor` because the computer must not depend on the
 * authentication module's internals; this is the one fact about it that matters here.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

function isBadRequest(value: unknown): value is BadRequest {
  return (
    !!value &&
    typeof value === "object" &&
    "error" in value &&
    !("action" in value)
  );
}

function asRef(
  body: Record<string, unknown> | null,
): { ref: string; snapshotId: number } | undefined {
  if (typeof body?.ref !== "string" || !body.ref) return undefined;
  if (typeof body?.snapshotId !== "number") return undefined;
  return { ref: body.ref, snapshotId: body.snapshotId };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Which HTTP status a failure deserves.
 *
 * Three genuinely different conditions that read identically if they all become 500: the computer is
 * not running (an operator fixes it), the refs are stale (the model fixes it by snapshotting again),
 * and everything else. Navigation established this; the acting routes follow it.
 */
function statusFor(error: unknown): 409 | 500 | 503 {
  if (error instanceof StaleSnapshotError) return 409;
  // The same answer as a stale snapshot, because it is the same instruction: the refs are wrong, take
  // another snapshot. Not 503, which says the computer is unavailable and sends an operator hunting a
  // container that is running perfectly.
  if (error instanceof ElementNotFoundError) return 409;
  // A person holding the wheel, or a person driving before taking it. Nothing is broken; the caller
  // has to wait or take control first, and 409 is how both of those are already reported.
  if (
    error instanceof ComputerUnavailableError &&
    /control/i.test(error.message)
  ) {
    return 409;
  }
  if (error instanceof ComputerUnavailableError) return 503;
  return 500;
}
