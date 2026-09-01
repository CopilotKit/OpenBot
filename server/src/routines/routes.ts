import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  RoutineNotFoundError,
  RoutineRefusedError,
  type RoutineRunOutcome,
  type RoutineStore,
  type RoutineSummary,
} from "./store";

export type { RoutineStore } from "./store";

/**
 * The routines page: what a person's standing instructions are, and a switch to stop one.
 *
 * THERE IS DELIBERATELY NO CREATE AND NO EDIT ENDPOINT HERE. Making a routine and changing one are
 * conversational — the four `RoutineTools` a Bot calls mid-chat, in `plugins/builtin-routines.ts` —
 * because the hard part of both is turning a sentence into a cron expression and a channel, which
 * is exactly what a conversation is for. This surface answers a narrower question: what is standing,
 * and does it stay standing. So it shows and it stops; it does not compose.
 *
 * THERE IS ALSO NO GET-BY-ID. A routine id is never a page's own state — nothing links to one, and
 * nothing needs to fetch one in isolation — so the list is the read, the same way the channel
 * roster is a list with no companion single-channel screen.
 *
 * Owner-scoped through the store on every route, never by filtering a broader read afterwards:
 * `listFor`, `setEnabled` and `remove` all take the caller's id and answer as if a routine that
 * belongs to somebody else does not exist, which is what keeps a wrong id and somebody else's id
 * indistinguishable from outside.
 */
export function createRoutineRoutes(
  routineStore: RoutineStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const routines = await routineStore.listFor(context.var.actor.id);
    return context.json({ routines: routines.map(routineDto) });
  });

  routes.put("/:id/enabled", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return context.json({ error: "enabled must be true or false." }, 400);
    }

    try {
      await routineStore.setEnabled(
        context.var.actor.id,
        context.req.param("id"),
        enabled,
      );
      return context.json({ enabled });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      await routineStore.remove(context.var.actor.id, context.req.param("id"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/**
 * One row of the routines page.
 *
 * THE DTO CARRIES THE WORDS, NOT THE CRON. The client never parses a schedule, so words-from-cron is
 * computed once, server-side, by the same library that decides when a routine actually fires — there
 * is no second implementation of cron-to-English anywhere to drift out of step with it. `schedule` is
 * opaque display text, never a value to parse: prose for the shapes `describeCron` recognizes, and
 * the raw five-field expression for everything stranger than that. `nextRunAt` is the one place a
 * time is computed, and it is computed the same way, by `nextOccurrence`.
 */
type RoutineDto = {
  id: string;
  /** Which Bot carries it out, so a Bot's own screen can show only its routines. */
  agentId: string;
  schedule: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  lastRun: { status: RoutineRunOutcome | null; at: string | null } | null;
};

function routineDto(routine: RoutineSummary): RoutineDto {
  return {
    id: routine.id,
    agentId: routine.agentId,
    schedule: routine.schedule,
    timezone: routine.timezone,
    instruction: routine.instruction,
    channel: {
      id: routine.channelId,
      name: routine.channelName,
      gone: routine.channelDeleted,
    },
    enabled: routine.enabled,
    nextRunAt: routine.nextRunAt.toISOString(),
    lastRun: routine.lastRun
      ? {
          status: routine.lastRun.status,
          at: routine.lastRun.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  // The store's own sentence, verbatim: it already reads the same whether the id belongs to nobody
  // or to somebody else, which is what keeps ownership unprobeable from out here.
  if (error instanceof RoutineNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof RoutineRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
