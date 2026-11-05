import { randomUUID } from "node:crypto";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
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
  /** Where a Bot closing a goal is recorded, with its evidence. Absent records nothing. */
  auditStore?: AuditStore;
}): GrantedTool[] {
  const {
    store,
    engine,
    ownerUserId,
    agentId,
    channelId,
    responsibilityRunId,
    auditStore,
  } = options;
  const identity = z.object({ id: z.string().trim().min(1).max(128) });
  async function owned(id: string) {
    const goal = await store.get(ownerUserId, id);
    if (goal.agentId !== agentId) throw new ResponsibilityNotFoundError();
    return goal;
  }
  /**
   * What shows the success criteria were met. Required whenever a Bot closes a goal.
   *
   * PROOF, NOT A CLAIM. The criteria are free text that no code can check, so the Bot has to say
   * what it checked them against: a link, a file, a test name, a number. It is kept on the goal and
   * on the trail, so a person reading a closed goal can see why it closed and check it themselves.
   */
  const evidenceSchema = z
    .string()
    .trim()
    .min(1, "Say what shows the success criteria were met.")
    .max(2000);

  /** What the store keeps of a goal's progress, the summary and the evidence together. */
  const PROGRESS_MAX = 6000;

  async function close(id: string, summary: string, evidence: string) {
    const goal = await owned(id);
    // The evidence is kept whole: it is what a person checks. A long summary gives way to it.
    const tail = `\n\nEvidence: ${evidence}`;
    const room = PROGRESS_MAX - tail.length;
    const kept =
      summary.length > room
        ? `${summary.slice(0, room - 1).trimEnd()}…`
        : summary;
    const closed = await store.recordProgress(
      ownerUserId,
      id,
      {
        summary: `${kept}${tail}`,
        complete: true,
        sourceRunId: responsibilityRunId,
      },
      agentId,
    );
    /*
     * After the goal is closed, and its failure only logged, the same as a trigger's row: the goal
     * did close, and telling the Bot otherwise would have it try to close a closed goal again.
     */
    if (auditStore)
      await recordAuditEvent(auditStore, {
        eventType: "responsibility.completed",
        targetType: "responsibility",
        targetId: id,
        actorUserId: ownerUserId,
        initiator: { kind: "responsibility", id },
        payload: {
          bot: agentId,
          criteria: goal.successCriteria,
          evidence,
          ...(responsibilityRunId ? { run: responsibilityRunId } : {}),
        },
      }).catch((error) =>
        console.error(
          JSON.stringify({
            type: "responsibility-completion-audit-failed",
            responsibilityId: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    return closed;
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
      "Record concrete progress for a responsibility. Mark complete only when its success criteria have been met, and then pass evidence: what you checked the criteria against (a link, a file, a test, a number).",
      identity
        .extend({
          summary: z.string().trim().min(1).max(PROGRESS_MAX),
          complete: z.boolean().optional(),
          evidence: evidenceSchema.optional(),
        })
        .refine((value) => !value.complete || value.evidence, {
          message:
            "Pass evidence that the success criteria were met before marking the responsibility complete.",
        }),
      async ({ id, summary, complete, evidence }) => {
        if (complete && evidence) return close(id, summary, evidence);
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
  tools.push(
    tool(
      "complete_responsibility",
      "Close this Bot's owned responsibility once its success criteria are met. Pass evidence: what you checked the criteria against (a link, a file, a test, a number).",
      identity.extend({ evidence: evidenceSchema }),
      ({ id, evidence }) => close(id, "Completed.", evidence),
    ),
  );
  for (const [action, status] of [
    ["pause", "paused"],
    ["resume", "active"],
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
