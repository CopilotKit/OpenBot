import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { RoutineRunner } from "./runner";
import { MINIMUM_INTERVAL_MS } from "./schedule";
import {
  NO_SHARED_CHANNEL,
  RoutineNotFoundError,
  RoutineRefusedError,
  type RoutineRefusalCode,
  type RoutineRunOutcome,
  type RoutineStore,
  type RoutineSummary,
} from "./store";

export type { RoutineStore } from "./store";

/**
 * The routines page: what a person's standing instructions are, a way to set one up, and a switch
 * to stop one.
 *
 * CREATE IS HERE, AND IT IS THE BOT'S OWN PATH. A person who has never met a routine looks for one
 * place to set one up, the way the Scheduled section of other assistants works, so the page offers
 * New routine. It writes through `routineStore.create`, the call `create_routine` makes in
 * `plugins/builtin-routines.ts`: the same instruction and title rules, the same frequency floor and
 * cap, the same audit row, and the same check that the conversation is one the person and the Bot
 * share. The page builds the five cron fields from a picker of common schedules; anything stranger
 * is still a conversation with the Bot. There is no edit endpoint: changing a routine stays
 * conversational.
 *
 * THERE IS ALSO NO GET-BY-ID. A routine id is never a page's own state — nothing links to one, and
 * nothing needs to fetch one in isolation — so the list is the read, the same way the channel
 * roster is a list with no companion single-channel screen.
 *
 * Owner-scoped through the store on every route, never by filtering a broader read afterwards:
 * `create`, `listFor`, `setEnabled` and `remove` all take the caller's id and answer as if a routine
 * that belongs to somebody else does not exist, which is what keeps a wrong id and somebody else's
 * id indistinguishable from outside.
 */
export function createRoutineRoutes(
  routineStore: RoutineStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: { runner?: RoutineRunner; auditStore?: AuditStore } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * Run now — the page's Test button. It DOES REAL WORK: the routine's Bot runs its instruction in
   * the routine's channel exactly as a scheduled firing would, through the same runner and headless
   * AG-UI path. A paused routine is refused (paused never runs), and so is a second click while a
   * run is still open.
   */
  if (options.runner) {
    const runner = options.runner;
    routes.post("/:id/run", requireUser, async (context) => {
      const id = context.req.param("id");
      try {
        const { runId } = await routineStore.startManualRun(
          context.var.actor.id,
          id,
        );
        if (options.auditStore)
          await recordAuditEvent(options.auditStore, {
            eventType: "routines.run_requested",
            targetType: "routine",
            targetId: id,
            actorUserId: context.var.actor.id,
            payload: { runId, source: "manual" },
          }).catch(() => undefined);
        void runner.run(runId).catch(() => {});
        return context.json({ accepted: true, runId }, 202);
      } catch (error) {
        return mapStoreError(context, error, "run");
      }
    });
  }

  routes.get("/:id/runs", requireUser, async (context) => {
    try {
      const runs = await routineStore.listRuns(
        context.var.actor.id,
        context.req.param("id"),
      );
      return context.json({
        runs: runs.map((run) => ({
          id: run.id,
          status: run.status ?? "running",
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          error: run.error,
          source: run.source,
        })),
      });
    } catch (error) {
      return mapStoreError(context, error, "runs");
    }
  });

  routes.get("/", requireUser, async (context) => {
    const [routines, sweptAt] = await Promise.all([
      routineStore.listFor(context.var.actor.id),
      routineStore.lastSweptAt().catch(() => null),
    ]);
    return context.json({
      routines: routines.map(routineDto),
      sweep: sweepDto(sweptAt),
    });
  });

  /*
   * New routine, from the page. The owner is the caller and never a field; the Bot is the one the
   * person picked, and the store accepts it only with a conversation the two of them share, which is
   * also what proves the person may use that Bot. The conversation is required here: the store's
   * fallbacks (the conversation a run was asked in, the only one shared) are for a Bot mid-turn, and
   * their refusals are questions written for the model.
   */
  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const text = (key: string): string | undefined => {
      const value = body?.[key];
      return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : undefined;
    };
    const agentId = text("agentId");
    if (!agentId) {
      return context.json({ error: "Choose a Bot for this routine." }, 400);
    }
    const instruction = text("instruction");
    if (!instruction) {
      return context.json({ error: "Say what the Bot should do." }, 400);
    }
    const cron = text("cron");
    if (!cron) {
      return context.json({ error: "Choose when it runs." }, 400);
    }
    const channelId = text("channelId");
    if (!channelId) {
      return context.json(
        { error: "Choose a conversation for it to post in." },
        400,
      );
    }
    try {
      const routine = await routineStore.create({
        ownerUserId: context.var.actor.id,
        agentId,
        instruction,
        title: text("title"),
        cron,
        timezone: text("timezone"),
        channelId,
        goalId: text("goalId"),
      });
      const summary = (await routineStore.listFor(context.var.actor.id)).find(
        (candidate) => candidate.id === routine.id,
      );
      return context.json(
        { routine: summary ? routineDto(summary) : { id: routine.id } },
        201,
      );
    } catch (error) {
      // The store lists the shared conversations by id for a model to pick from; a person picks
      // from the form instead.
      if (
        error instanceof RoutineRefusedError &&
        error.message.startsWith(NO_SHARED_CHANNEL)
      ) {
        return context.json(
          {
            error:
              "This Bot isn't in that conversation. Choose another one, or a new conversation.",
          },
          400,
        );
      }
      return mapStoreError(context, error, "create");
    }
  });

  routes.put("/:id/enabled", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return context.json({ error: "enabled must be true or false." }, 400);
    }
    // An empty id would reach the store and answer 500 on some backends instead of a 400 for a
    // malformed call. Owner-scoping stays in the store; shape is checked here.
    const id = context.req.param("id");
    if (!id.trim()) {
      return context.json({ error: "A routine id is required." }, 400);
    }

    try {
      await routineStore.setEnabled(context.var.actor.id, id, enabled);
      return context.json({ enabled });
    } catch (error) {
      return mapStoreError(context, error, "enable");
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    if (!id.trim()) {
      return context.json({ error: "A routine id is required." }, 400);
    }
    try {
      await routineStore.remove(context.var.actor.id, id);
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error, "delete");
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
  /** What the person called it, or null: the page then names it by its schedule. */
  title: string | null;
  /**
   * Where it posts. `title` is the conversation as the sidebar titles it, which is what a person
   * recognises it by; `name` is only its Bots' names, the same for every conversation with them.
   */
  channel: {
    id: string;
    name: string | null;
    title: string | null;
    gone: boolean;
  };
  enabled: boolean;
  nextRunAt: string;
  lastRun: { status: RoutineRunOutcome | null; at: string | null } | null;
  /** The goal it runs, or null. The Routines page shows it as a start of that goal, not a row. */
  goalId: string | null;
};

export const SWEEP_SILENCE_MS = MINIMUM_INTERVAL_MS;

type SweepDto = {
  lastSweptAt: string | null;
  working: boolean;
};

function sweepDto(sweptAt: Date | null, now = new Date()): SweepDto {
  return {
    lastSweptAt: sweptAt?.toISOString() ?? null,
    working:
      sweptAt !== null && now.getTime() - sweptAt.getTime() <= SWEEP_SILENCE_MS,
  };
}

function routineDto(routine: RoutineSummary): RoutineDto {
  return {
    id: routine.id,
    agentId: routine.agentId,
    schedule: routine.schedule,
    timezone: routine.timezone,
    instruction: routine.instruction,
    title: routine.title,
    channel: {
      id: routine.channelId,
      name: routine.channelName,
      title: routine.channelTitle,
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
    goalId: routine.goalId,
  };
}

/** The routes that answer a store refusal, each with its own sentences. */
type RefusalRoute = "create" | "enable" | "run" | "runs" | "delete";

/**
 * The refusals the store words for a model (it names a tool, or says "I"), said to a person. The
 * store keeps its own sentence for the Bot's tools; the rest read well as they are.
 *
 * KEYED BY ROUTE, THEN CODE, because the same refusal asks for different things on different
 * screens. Only the create form offers a goal or a time zone to choose again; the enable switch
 * offers nothing to choose, and there is no edit endpoint, so a routine with a time zone OpenBot
 * doesn't know can only be replaced. A code a route can't raise has no entry there, and an entry
 * missing for a coded refusal falls back to the store's own sentence.
 *
 * Call sites: POST / (create), PUT /:id/enabled (enable), POST /:id/run (run), GET /:id/runs (runs),
 * DELETE /:id (delete).
 */
const PERSON_REFUSALS: Record<
  RefusalRoute,
  Partial<Record<RoutineRefusalCode, string>>
> = {
  create: {
    goal_not_found: "This Bot doesn't have that goal. Choose another one.",
    goal_complete:
      "That goal is complete, so a routine can't run it. Choose another one.",
    unknown_timezone:
      "OpenBot doesn't know that time zone. Choose another one.",
  },
  enable: {
    unknown_timezone:
      "This routine's time zone isn't one OpenBot knows. Ask its Bot to change its schedule.",
  },
  run: {},
  runs: {},
  delete: {},
};

function mapStoreError(
  context: Context,
  error: unknown,
  route: RefusalRoute,
): Response {
  // The store's own sentence, verbatim: it already reads the same whether the id belongs to nobody
  // or to somebody else, which is what keeps ownership unprobeable from out here.
  if (error instanceof RoutineNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof RoutineRefusedError) {
    return context.json(
      {
        error:
          (error.code && PERSON_REFUSALS[route][error.code]) ?? error.message,
      },
      400,
    );
  }
  throw error;
}
