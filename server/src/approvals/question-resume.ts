import { PERSON_INITIATOR } from "../audit";
import type {
  Responsibility,
  ResponsibilityStore,
} from "../responsibilities/types";
import type { TurnRunner } from "../routines/runner";
import {
  type PersonQuestion,
  questionConversationBot,
  questionResponseMessage,
} from "./questions";
import { ApprovalRefusedError } from "./types";

/** The waiting kind a responsibility run is suspended under while its question is unanswered. */
export const PERSON_QUESTION_WAITING = "person_question";

/**
 * A person's answer to a Bot's question, resumed as the same kind of turn that asked it.
 *
 * The answer goes back into the same conversation as a user message either way. What differs is the
 * turn around it: a question asked by a responsibility's run must come back to that responsibility,
 * run with its tools (`report_responsibility_progress` bound to its latest run) and its initiator,
 * or the Bot can read the answer but cannot record progress or complete the goal it was working on.
 * A question from anything else keeps the initiator it was asked under rather than becoming a
 * person's own turn.
 */
export async function resumePersonQuestion(input: {
  ownerUserId: string;
  question: PersonQuestion;
  response: string;
  messageId: string;
  /** The ordinary headless runner: computer tools, the question's own initiator. */
  runTurn: TurnRunner;
  responsibilities?: Pick<
    ResponsibilityStore,
    "get" | "listRuns" | "resumeWaiting"
  >;
  /** A runner carrying the responsibility's own tools, bound to one of its runs. */
  responsibilityTurn?: (goal: {
    responsibility: Responsibility;
    responsibilityRunId: string | undefined;
  }) => TurnRunner;
}): Promise<{ replyText: string; responsibilityId?: string }> {
  const { question, ownerUserId } = input;
  if (question.actorId !== ownerUserId)
    throw new ApprovalRefusedError("The saved question owner does not match.");
  const agentId = questionConversationBot(question);
  const userMessage = questionResponseMessage(
    question,
    input.response,
    input.messageId,
  );
  const initiator = question.initiator ?? PERSON_INITIATOR;
  if (
    initiator.kind === "responsibility" &&
    input.responsibilities &&
    input.responsibilityTurn
  ) {
    // Owner-scoped: another person's responsibility id is not found.
    const responsibility = await input.responsibilities.get(
      ownerUserId,
      initiator.id,
    );
    if (
      responsibility.threadId !== question.threadId ||
      responsibility.agentId !== agentId
    )
      throw new ApprovalRefusedError(
        "That answer does not belong to this responsibility's conversation.",
      );
    const [latest] = await input.responsibilities.listRuns(
      ownerUserId,
      responsibility.id,
    );
    /*
     * The run that asked is waiting for exactly this: resume it, with the answer as its question's
     * result. It runs again as the responsibility's current run, so it may record progress and
     * complete, and its reply goes wherever a responsibility's replies go.
     */
    if (
      latest?.status === "waiting" &&
      latest.waiting?.kind === PERSON_QUESTION_WAITING
    ) {
      await input.responsibilities.resumeWaiting(ownerUserId, latest.id, {
        content: `The person answered: ${input.response}`,
      });
      return { replyText: "", responsibilityId: responsibility.id };
    }
    const run = input.responsibilityTurn({
      responsibility,
      responsibilityRunId: latest?.id,
    });
    const outcome = await run({
      ownerUserId,
      routineId: responsibility.id,
      agentId,
      threadId: question.threadId,
      initiator,
      instruction: "",
      userMessage,
    });
    return { ...outcome, responsibilityId: responsibility.id };
  }
  return input.runTurn({
    ownerUserId,
    routineId: "person-response",
    agentId,
    threadId: question.threadId,
    initiator,
    instruction: "",
    userMessage,
  });
}
