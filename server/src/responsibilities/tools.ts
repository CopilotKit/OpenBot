import { randomUUID } from "node:crypto";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { ResponsibilityEngine } from "./engine";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
  responsibilityInputSchema,
  responsibilityPatchSchema,
  whyItRepeats,
} from "./types";

/**
 * A goal's own tools, for the run that works on it. Identities come from the signed run, never model
 * arguments.
 *
 * Named and described as a goal, the word every screen uses: the model repeats the words its tools
 * give it, and a run's reply is what the person reads in the conversation and in Activity. When they
 * were `*_responsibility`, a goal's run told the person "I've marked the responsibility complete".
 * The code, the routes and the database keep the old word.
 *
 * A RUN OF A GOAL THAT REPEATS IS ONE OF MANY (`GoalRepeats`). It records its result with
 * `report_goal_progress` and the goal stays active: `complete_goal` refuses, in a sentence the model
 * can pass on, and `complete` is not acted on. FOUND ON WINDOWS: the first run of a goal a daily
 * routine runs met its success criteria, as every run of it would, and completed the goal; the Bot
 * then made a second goal to repoint the routine at. Ending a goal that repeats is the person's, from
 * a conversation or the goal's card. Checked when the run asks, not when it starts, so a routine made
 * while the run works counts.
 */
export function responsibilityTools(options: {
  store: ResponsibilityStore;
  engine: Pick<ResponsibilityEngine, "ingest">;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  responsibilityRunId?: string;
}): GrantedTool[] {
  const {
    store,
    engine,
    ownerUserId,
    agentId,
    channelId,
    responsibilityRunId,
  } = options;
  const identity = z.object({ id: z.string().trim().min(1).max(128) });
  async function owned(id: string) {
    const goal = await store.get(ownerUserId, id);
    if (goal.agentId !== agentId) throw new ResponsibilityNotFoundError();
    return goal;
  }
  /**
   * Why a run may not end this goal: it repeats. Null in a conversation, where the person asks, and
   * for a goal that is done once.
   */
  async function repeatsInRun(id: string) {
    if (!responsibilityRunId) return null;
    const repeats = await store.repeats(ownerUserId, id);
    return repeats
      ? `This goal repeats because ${whyItRepeats(repeats)}, so a run can't complete it. It stays active. Only the person ends it.`
      : null;
  }
  function tool<T>(
    name: string,
    description: string,
    parameters: z.ZodType<T>,
    execute: (value: T) => Promise<unknown>,
  ): GrantedTool {
    return {
      name,
      ref: `responsibility/${name}`,
      description,
      parameters,
      async execute(args) {
        const value = parameters.safeParse(args);
        if (!value.success)
          return `Refused. ${value.error.issues[0]?.message ?? "Invalid goal arguments."}`;
        try {
          return JSON.stringify(await execute(value.data));
        } catch (error) {
          if (
            error instanceof ResponsibilityNotFoundError ||
            error instanceof ResponsibilityRefusedError
          )
            return `Refused. ${error.message}`;
          throw error;
        }
      },
    };
  }
  const tools = [
    tool(
      "create_goal",
      "Create a lasting goal for this Bot in this conversation. State the instruction and measurable success criteria; optional event subscriptions trigger future runs. Set recurring when the person wants it done again and again, every morning or each time something happens: a recurring goal is never completed by one of its runs.",
      responsibilityInputSchema.omit({ agentId: true, channelId: true }),
      (input) => store.create(ownerUserId, { ...input, agentId, channelId }),
    ),
    tool(
      "list_goals",
      "List this person's goals for this Bot, with their progress.",
      z.object({}).strict(),
      async () =>
        (await store.list(ownerUserId)).filter(
          (goal) => goal.agentId === agentId,
        ),
    ),
    tool(
      "update_goal",
      "Edit a goal's instruction, success criteria, title or event subscriptions.",
      identity.extend({ patch: responsibilityPatchSchema }),
      async ({ id, patch }) => {
        await owned(id);
        return store.update(ownerUserId, id, patch);
      },
    ),
    tool(
      "report_goal_progress",
      "Record this run's result for a goal: what it found or did, with evidence. Set complete only for a goal that is done once, when its success criteria are met and nothing is left to do: it ends the goal for good. A goal that repeats stays active after every run, and only the person ends it.",
      identity.extend({
        summary: z.string().trim().min(1).max(6000),
        complete: z.boolean().optional(),
      }),
      async ({ id, summary, complete }) => {
        await owned(id);
        const repeats = complete ? await repeatsInRun(id) : null;
        const goal = await store.recordProgress(
          ownerUserId,
          id,
          {
            summary,
            complete: complete && !repeats,
            sourceRunId: responsibilityRunId,
          },
          agentId,
        );
        // The result is kept; only the ending is not acted on, and the run is told why.
        return repeats ? { ...goal, note: `Recorded. ${repeats}` } : goal;
      },
    ),
    tool(
      "run_goal",
      "Queue one of this Bot's active goals to be worked on without the person's browser open.",
      identity,
      async ({ id }) => {
        const goal = await owned(id);
        /*
         * A goal that is not active never runs, so asking says so. Before, it answered with no run at
         * all, and a routine that runs a goal the person ended said nothing each time it fired.
         */
        if (goal.status === "completed")
          throw new ResponsibilityRefusedError(
            `"${goal.title}" is complete, so it no longer runs and nothing was done. Tell the person, and ask whether to set it up again as a new goal or switch off what runs it.`,
          );
        if (goal.status === "paused")
          throw new ResponsibilityRefusedError(
            `"${goal.title}" is paused, so it didn't run. Resume it first, if the person wants it to run.`,
          );
        return engine.ingest({
          ownerUserId,
          responsibilityId: id,
          source: "manual",
          externalId: randomUUID(),
          type: "requested",
          payload: {},
        });
      },
    ),
  ];
  for (const [action, status, description] of [
    ["pause", "paused", "Pause one of this Bot's goals."],
    ["resume", "active", "Resume one of this Bot's paused goals."],
    [
      "complete",
      "completed",
      "End one of this Bot's goals for good: it never runs again and can't be resumed. Only for a goal that is done once, when its success criteria are met, or when the person says it is done. A goal that repeats is never completed by one of its runs.",
    ],
  ] as const) {
    tools.push(
      tool(`${action}_goal`, description, identity, async ({ id }) => {
        await owned(id);
        const repeats = action === "complete" ? await repeatsInRun(id) : null;
        if (repeats) throw new ResponsibilityRefusedError(repeats);
        return store.transition(ownerUserId, id, status);
      }),
    );
  }
  return tools;
}
