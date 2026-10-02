import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";
import type { ResponsibilityEngine } from "./engine";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
  responsibilityInputSchema,
  responsibilityPatchSchema,
} from "./types";

/** Identities come from the signed run, never model arguments. */
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
          return `Refused. ${value.error.issues[0]?.message ?? "Invalid responsibility arguments."}`;
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
      "create_responsibility",
      "Create a durable goal for this Bot in this conversation. State the instruction and measurable success criteria; optional event subscriptions trigger future runs.",
      responsibilityInputSchema.omit({ agentId: true, channelId: true }),
      (input) => store.create(ownerUserId, { ...input, agentId, channelId }),
    ),
    tool(
      "list_responsibilities",
      "Inspect this person's durable responsibilities and progress for this Bot.",
      z.object({}).strict(),
      async () =>
        (await store.list(ownerUserId)).filter(
          (goal) => goal.agentId === agentId,
        ),
    ),
    tool(
      "update_responsibility",
      "Edit a responsibility's instruction, success criteria, title or event subscriptions.",
      identity.extend({ patch: responsibilityPatchSchema }),
      async ({ id, patch }) => {
        await owned(id);
        return store.update(ownerUserId, id, patch);
      },
    ),
    tool(
      "report_responsibility_progress",
      "Record concrete progress and evidence for a responsibility. Mark complete only when its success criteria have been met.",
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
      "run_responsibility",
      "Queue an owned active responsibility for this Bot to work on without the person's browser open.",
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
  for (const [action, status] of [
    ["pause", "paused"],
    ["resume", "active"],
    ["complete", "completed"],
  ] as const) {
    tools.push(
      tool(
        `${action}_responsibility`,
        `${action} this Bot's owned responsibility.`,
        identity,
        async ({ id }) => {
          await owned(id);
          return store.transition(ownerUserId, id, status);
        },
      ),
    );
  }
  return tools;
}
