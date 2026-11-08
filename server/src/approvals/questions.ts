import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { questionPartSchema } from "../agents/escalation";
import { groupSourceForRun, submitGroupTurn } from "../channels/group";
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
/**
 * Whether an answer given in the open conversation goes on there, as that conversation's next turn.
 *
 * A question a person's own turn asked is answered by the person's next turn, and the screen they
 * typed it on is where that turn belongs: run there, it streams its steps as they happen, has a Stop,
 * and has every tool the conversation's turns have. Resumed here instead, it ran headless and the
 * screen showed only "reading your answer" until the whole turn was over.
 *
 * A question asked under anything else (a routine, a responsibility, a hand-off) still comes back
 * here: its answer resumes that run's work with that run's own tools and initiator, which the
 * conversation's turn does not have.
 */
export const questionContinuesInConversation = (question: PersonQuestion) =>
  question.initiator === undefined || question.initiator.kind === "person";
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
    /**
     * Answer a question. Resumed here, as a queued turn, unless the answer was given in the open
     * conversation (`inConversation`) and that conversation's next turn is where it belongs
     * (`questionContinuesInConversation`): then the question is closed and the conversation runs
     * the answer as its own turn, which `continueHere` in the result tells it to.
     *
     * A question a Bot asked in a group conversation is answered in that group, wherever the answer
     * was given: the person's words go into the shared transcript, and that Bot answers them in its
     * next group turn, told what they answer. Resumed here instead, the Bot's reply went to its own
     * thread and never reached the group the question was asked in.
     */
    async respond(
      owner: string,
      id: string,
      response: string,
      { inConversation = false }: { inConversation?: boolean } = {},
    ): Promise<
      { id: string; queued: true } | { id: string; continueHere: true }
    > {
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
      const group = await groupSourceForRun(database, {
        threadId: parsed.data.threadId,
        actorId: owner,
        botId: questionConversationBot(parsed.data),
      });
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
        if (group) {
          await tx
            .update(workItems)
            .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
            .where(owned(owner, id));
          await submitGroupTurn(tx, {
            ownerUserId: owner,
            channelId: group.channelId,
            messageId: `person-response:${id}`,
            agentIds: [group.botId],
            text: answer,
            inResponseTo: parsed.data.question,
          });
          return { id, queued: true as const };
        }
        if (inConversation && questionContinuesInConversation(parsed.data)) {
          await tx
            .update(workItems)
            .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
            .where(owned(owner, id));
          return { id, continueHere: true as const };
        }
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
        return { id, queued: true as const };
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
