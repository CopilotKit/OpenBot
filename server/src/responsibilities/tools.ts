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
} from "./types";

/**
 * A goal's own tools, for the run that works on it. Identities come from the signed run, never model
 * arguments.
 *
 * Named and described as a goal, the word every screen uses: the model repeats the words its tools
 * give it, and a run's reply is what the person reads in the conversation and in Activity. When they
 * were `*_responsibility`, a goal's run told the person "I've marked the responsibility complete".
 * The code, the routes and the database keep the old word.
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
      "Create a lasting goal for this Bot in this conversation. State the instruction and measurable success criteria; optional event subscriptions trigger future runs.",
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
      "Record concrete progress and evidence for a goal. Mark the goal complete only when its success criteria have been met.",
      identity.extend({
        summary: z.string().trim().min(1).max(6000),
        complete: z.boolean().optional(),
      }),
      async ({ id, summary, complete }) => {
        await owned(id);
        return store.recordProgress(
          ownerUserId,
          id,
          { summary, complete, sourceRunId: responsibilityRunId },
          agentId,
        );
      },
    ),
    tool(
      "run_goal",
      "Queue one of this Bot's active goals to be worked on without the person's browser open.",
      identity,
      async ({ id }) => {
        await owned(id);
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
    ["complete", "completed", "Mark one of this Bot's goals complete."],
  ] as const) {
    tools.push(
      tool(`${action}_goal`, description, identity, async ({ id }) => {
        await owned(id);
        return store.transition(ownerUserId, id, status);
      }),
    );
  }
  return tools;
}
