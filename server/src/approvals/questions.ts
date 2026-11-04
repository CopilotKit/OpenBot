import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { questionPartSchema } from "../agents/escalation";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import { ApprovalNotFoundError, ApprovalRefusedError } from "./types";

const questionSchema = z.object({
  actorId: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  question: z.string().min(1).max(6000),
  why: z.string().max(6000).optional(),
  /** The separate decisions inside the question, each answered on its own. */
  parts: z.array(questionPartSchema).max(6).optional(),
  mode: z.literal("completed_question"),
  sourceBotId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  /**
   * What started the run that asked. Kept so the answer resumes that run's work as the same kind of
   * turn: a responsibility's question comes back to the responsibility, with its tools.
   */
  initiator: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("person") }),
      z.object({ kind: z.literal("deployment") }),
      z.object({ kind: z.literal("routine"), id: z.string().min(1) }),
      z.object({ kind: z.literal("responsibility"), id: z.string().min(1) }),
      z.object({ kind: z.literal("memory"), id: z.string().min(1) }),
      z.object({ kind: z.literal("handoff"), id: z.string().min(1) }),
    ])
    .optional(),
});
export const personQuestionSchema = questionSchema;
export type PersonQuestion = z.infer<typeof questionSchema>;
export const questionConversationBot = (question: PersonQuestion) =>
  question.sourceBotId ?? question.botId;
export const questionResponseMessage = (
  question: PersonQuestion,
  response: string,
  id: string,
) => ({
  id,
  role: "user" as const,
  content: `In response to your question: ${question.question}\n\n${response}`,
});
/**
 * A waiting question as the person's inbox lists it, or null for a row that is not one.
 *
 * `conversationBotId` is the Bot whose conversation the question belongs to: for a hand-off, the Bot
 * that handed the work on, not the one that asked. It is the Bot the attention badge and the Bot's
 * activity count the question under, so a screen showing one Bot's questions filters on it.
 */
export function listedQuestion(row: {
  key: string;
  payload: unknown;
  createdAt: Date;
}) {
  const value = questionSchema.safeParse(row.payload);
  return value.success
    ? {
        id: row.key,
        botId: value.data.botId,
        conversationBotId: questionConversationBot(value.data),
        threadId: value.data.threadId,
        /** The conversation it was asked in, which is where it is answered. */
        channelId: value.data.channelId,
        question: value.data.question,
        why: value.data.why,
        parts: value.data.parts,
        createdAt: row.createdAt,
      }
    : null;
}
export type ApprovalQuestions = ReturnType<typeof createApprovalQuestions>;
export function createApprovalQuestions(
  database: Database,
  authorise: (question: PersonQuestion) => Promise<void>,
) {
  const owned = (owner: string, key?: string) =>
    and(
      eq(workItems.kind, "person.question"),
      sql`${workItems.payload}->>'actorId' = ${owner}`,
      ...(key ? [eq(workItems.key, key)] : []),
    );
  return {
    async list(owner: string) {
      const rows = await database
        .select()
        .from(workItems)
        .where(and(owned(owner), isNull(workItems.finishedAt)))
        .orderBy(desc(workItems.createdAt))
        .limit(100);
      return rows.map(listedQuestion).filter((row) => row !== null);
    },
    async respond(owner: string, id: string, response: string) {
      const answer = z.string().trim().min(1).max(6000).parse(response);
      const [current] = await database
        .select()
        .from(workItems)
        .where(owned(owner, id))
        .limit(1);
      if (!current) throw new ApprovalNotFoundError();
      const parsed = questionSchema.safeParse(current.payload);
      if (!parsed.success)
        throw new ApprovalRefusedError(
          "This question has no completed conversation to continue.",
        );
      await authorise(parsed.data);
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(workItems)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!row) throw new ApprovalNotFoundError();
        if (row.finishedAt)
          throw new ApprovalRefusedError("You already answered this question.");
        await tx
          .insert(workItems)
          .values({
            kind: "person.response",
            key: id,
            payload: {
              ownerUserId: owner,
              question: parsed.data,
              response: answer,
            },
          })
          .onConflictDoNothing();
        await tx
          .update(workItems)
          .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(owned(owner, id));
        await tx.execute(
          sql`select pg_notify('openbot_work_offered', 'person.response')`,
        );
        return { id, queued: true };
      });
    },
    /**
     * Put a question down without answering it. The run that asked already finished, so nothing
     * is resumed and nothing is sent to the Bot: the question just stops waiting on the person.
     */
    async dismiss(owner: string, id: string) {
      const [row] = await database
        .update(workItems)
        .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(owned(owner, id), isNull(workItems.finishedAt)))
        .returning({ key: workItems.key });
      if (!row) throw new ApprovalNotFoundError();
      return { id, dismissed: true };
    },
  };
}
