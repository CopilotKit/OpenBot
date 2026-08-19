/**
 * The signed-in surface for routines and webhook triggers.
 *
 * Two different things behind one prefix, and they are guarded differently because they belong to
 * different people. A routine is somebody's own work: every route for one is scoped to the person
 * asking, in the query rather than after it, because a routine carries a prompt they wrote about
 * their own job and "we fetched it and then decided not to show it" is the shape most accidental
 * disclosures take. A webhook trigger is a door in the side of the deployment, so it belongs to
 * whoever answers for the deployment: the trigger routes require an administrator and are not scoped
 * to a creator at all, because the question they exist to answer is "what can reach us from
 * outside", which no per-person list answers correctly.
 *
 * The public side of a webhook is not here. It is a different process on a different port, see
 * receiver.ts, and this file only ever manages the triggers rather than receiving anything.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { parseRoutineSchedule, type RoutineSchedule } from "./schedule";
import type { Scheduler } from "./scheduler";
import type { RoutineStore } from "./store";

/**
 * The actor, in the shape the store wants.
 *
 * The local development actor is a real row in `users`, unlike the situation the computer routes
 * guard against, because a routine's owner is a foreign key to that table and the routine could not
 * exist otherwise. So the id travels as both.
 */
function actorOf(context: { var: AppVariables }) {
  return { id: context.var.actor.id, userId: context.var.actor.id };
}

export function createRoutineRoutes(
  store: RoutineStore,
  /** Absent when the scheduler is switched off: routines can still be written, nothing runs them. */
  scheduler: Scheduler | undefined,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) =>
    context.json({ routines: await store.list(context.var.actor.id) }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const input = routineInput(body);
    if ("error" in input) return context.json({ error: input.error }, 400);

    return context.json(
      {
        routine: await store.create(
          {
            agentId: input.agentId,
            ownerUserId: context.var.actor.id,
            name: input.name,
            prompt: input.prompt,
            schedule: input.schedule,
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          },
          actorOf(context),
        ),
      },
      201,
    );
  });

  routes.patch("/:routineId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return context.json({ error: "A change is required." }, 400);

    const patch: {
      name?: string;
      prompt?: string;
      schedule?: RoutineSchedule;
      enabled?: boolean;
    } = {};
    if (body.name !== undefined) {
      const name = trimmed(body.name);
      if (!name) return context.json({ error: "A name is required." }, 400);
      patch.name = name;
    }
    if (body.prompt !== undefined) {
      const prompt = trimmed(body.prompt);
      if (!prompt) {
        return context.json(
          { error: "Say what the Bot should do when this runs." },
          400,
        );
      }
      patch.prompt = prompt;
    }
    if (body.schedule !== undefined) {
      const schedule = parseRoutineSchedule(body.schedule);
      // Refused rather than repaired. A schedule is the thing that decides when a Bot acts on
      // somebody's live systems, and "we accepted your schedule but not in the shape you wrote it"
      // is the one behaviour that must never happen here.
      if (!schedule) {
        return context.json({ error: INVALID_SCHEDULE }, 400);
      }
      patch.schedule = schedule;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return context.json({ error: "enabled must be true or false." }, 400);
      }
      patch.enabled = body.enabled;
    }

    const routine = await store.update(
      context.req.param("routineId"),
      context.var.actor.id,
      patch,
      actorOf(context),
    );
    return routine
      ? context.json({ routine })
      : context.json({ error: "No such routine." }, 404);
  });

  routes.delete("/:routineId", requireUser, async (context) => {
    const removed = await store.remove(
      context.req.param("routineId"),
      context.var.actor.id,
      actorOf(context),
    );
    return removed
      ? context.json({ deleted: true })
      : context.json({ error: "No such routine." }, 404);
  });

  routes.get("/:routineId/runs", requireUser, async (context) => {
    // The ownership check is the `get`, which is scoped. Listing runs without it would let anybody
    // with a routine id read what somebody else's Bot found.
    const routine = await store.get(
      context.req.param("routineId"),
      context.var.actor.id,
    );
    if (!routine) return context.json({ error: "No such routine." }, 404);
    return context.json({ runs: await store.runs(routine.id) });
  });

  /**
   * Run it now.
   *
   * The same path a scheduled run takes, on purpose: the same runner, the same gateway, the same
   * rows. What differs is the `trigger` recorded on the run and, to the boundary, nothing at all,
   * because a person who presses this then walks away is as absent as the clock is.
   */
  routes.post("/:routineId/run", requireUser, async (context) => {
    const routine = await store.get(
      context.req.param("routineId"),
      context.var.actor.id,
    );
    if (!routine) return context.json({ error: "No such routine." }, 404);
    if (!scheduler) {
      return context.json(
        {
          error:
            "Routines are switched off in this deployment, so nothing can be run.",
        },
        503,
      );
    }

    const outcome = await scheduler.runNow(routine.id, actorOf(context));
    if (outcome === "unknown") {
      return context.json({ error: "No such routine." }, 404);
    }
    // 409 for busy, because nothing is wrong: the work is already being done. Reporting it as an
    // error would teach somebody to press the button again.
    return outcome === "busy"
      ? context.json(
          { status: "busy", detail: "This routine is already running." },
          409,
        )
      : context.json({ status: "started" }, 202);
  });

  /*
   * Everything below this line is an administrator's.
   *
   * A trigger is not somebody's own work the way a routine is. It is a URL on the public internet
   * that sets a Bot working, which is a fact about the whole deployment, and the two halves of that
   * have to agree about whose it is. They did not: the routes admitted any signed-in person and the
   * only page that renders them is behind the administrator guard, so an ordinary user could mint a
   * publicly reachable endpoint through the API and then had nowhere to see or revoke it, while an
   * administrator opening the page to review this deployment's exposure was shown only the triggers
   * they had personally created and could not shut a door anybody else had opened.
   *
   * So: an administrator, and every trigger, not their own. What it costs is that somebody who is
   * not an administrator cannot give their routine a webhook at all, and has to ask. That is the
   * right way round for the one surface in this product that answers to strangers.
   */
  routes.get("/triggers", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ triggers: await store.listTriggers() });
  });

  /**
   * Make a trigger, and show its secret exactly once.
   *
   * The secret is in this response and nowhere else, ever. It is not in the list, not readable
   * afterwards, and not recoverable: the row keeps a hash. Somebody who loses it rotates, which is
   * one click and is the honest answer, rather than the product keeping a copy so it can be shown
   * again on a screen anybody with the session can open.
   */
  routes.post("/triggers", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const name = trimmed(body?.name);
    if (!name) return context.json({ error: "A name is required." }, 400);

    const routineId = trimmed(body?.routineId);
    const agentId = trimmed(body?.agentId);
    const prompt = trimmed(body?.prompt);

    // One or the other, never both and never neither. A trigger that named a routine AND carried a
    // prompt would have two answers to "what does this do", and the one it used would be whichever
    // the code happened to check first.
    if (Boolean(routineId) === Boolean(agentId && prompt)) {
      return context.json(
        {
          error:
            "A trigger either runs a routine, or names a Bot and what to tell it. Give one, not both.",
        },
        400,
      );
    }
    if (routineId) {
      // Their own routine, even here. An administrator may manage every door in the deployment, and
      // that is not the same as being able to point a new one at somebody else's work: a routine
      // runs with its owner's authority, so wiring a stranger's routine to a public URL would be
      // handing out somebody else's access without their knowing.
      const routine = await store.get(routineId, context.var.actor.id);
      if (!routine) return context.json({ error: "No such routine." }, 404);
    }

    const eventTypes = stringList(body?.eventTypes);
    if (eventTypes === null) {
      return context.json(
        { error: "eventTypes must be a list of names." },
        400,
      );
    }

    const created = await store.createTrigger(
      {
        name,
        ownerUserId: context.var.actor.id,
        ...(routineId ? { routineId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(prompt ? { prompt } : {}),
        eventTypes,
      },
      actorOf(context),
    );
    return context.json(created, 201);
  });

  routes.patch("/triggers/:triggerId", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const patch: { enabled?: boolean; eventTypes?: string[] } = {};
    if (body?.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return context.json({ error: "enabled must be true or false." }, 400);
      }
      patch.enabled = body.enabled;
    }
    if (body?.eventTypes !== undefined) {
      const eventTypes = stringList(body.eventTypes);
      if (eventTypes === null) {
        return context.json(
          { error: "eventTypes must be a list of names." },
          400,
        );
      }
      patch.eventTypes = eventTypes;
    }

    const trigger = await store.updateTrigger(
      context.req.param("triggerId"),
      patch,
      actorOf(context),
    );
    return trigger
      ? context.json({ trigger })
      : context.json({ error: "No such trigger." }, 404);
  });

  /**
   * Confirm what actually arrived, so the trigger starts doing work.
   *
   * Refused when nothing has arrived yet. Confirming a trigger nothing has ever called confirms
   * nothing, and would turn the one gate that catches a misdirected hook into a box somebody ticks
   * on their way past.
   */
  routes.post("/triggers/:triggerId/verify", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const trigger = await store.verifyTrigger(
      context.req.param("triggerId"),
      actorOf(context),
    );
    return trigger
      ? context.json({ trigger })
      : context.json(
          {
            error:
              "There is nothing to confirm yet. Send a delivery to this endpoint first, then look at what arrived.",
          },
          409,
        );
  });

  routes.post("/triggers/:triggerId/rotate", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const rotated = await store.rotateTriggerSecret(
      context.req.param("triggerId"),
      actorOf(context),
    );
    return rotated
      ? context.json(rotated)
      : context.json({ error: "No such trigger." }, 404);
  });

  routes.delete("/triggers/:triggerId", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const removed = await store.deleteTrigger(
      context.req.param("triggerId"),
      actorOf(context),
    );
    return removed
      ? context.json({ deleted: true })
      : context.json({ error: "No such trigger." }, 404);
  });

  return routes;
}

const INVALID_SCHEDULE =
  'A schedule is either {"type":"once","at":"<ISO time>"} or ' +
  '{"type":"daily","time":"HH:MM","weekdays":[1,2,3,4,5]}, in UTC, with 0 for Sunday.';

type RoutineInput = {
  agentId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
};

function routineInput(value: unknown): RoutineInput | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "A routine is required." };
  }
  const body = value as Record<string, unknown>;

  const agentId = trimmed(body.agentId);
  if (!agentId) return { error: "Choose a Bot to run this." };
  const name = trimmed(body.name);
  if (!name) return { error: "A name is required." };
  const prompt = trimmed(body.prompt);
  if (!prompt) return { error: "Say what the Bot should do when this runs." };
  const schedule = parseRoutineSchedule(body.schedule);
  if (!schedule) return { error: INVALID_SCHEDULE };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return { error: "enabled must be true or false." };
  }

  return {
    agentId,
    name,
    prompt,
    schedule,
    ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
  };
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A list of names, or null for something that was sent but is not one. Absent means empty. */
function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const name = entry.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
