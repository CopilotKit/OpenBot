import { and, eq, sql } from "drizzle-orm";
import {
  type ApprovalContinuation,
  parseApprovalContinuation,
} from "../approvals/types";
import type { Database } from "../db/client";
import { intelligenceChannelMappings, routineRuns } from "../db/schema";
import { responsibilityRuns } from "../db/schema/responsibilities";
import type { DeliveryScope } from "../delivery/types";
import { signInToolResult } from "./service";
import type { SignInRequestRecord } from "./types";

/**
 * What happens to an unattended turn once its sign-in request is answered.
 *
 * The same two paths an approval takes (index.ts, the approval sweep): a responsibility run that is
 * waiting on this request is re-queued with the outcome as its tool result, and any other headless
 * turn is continued from the snapshot the tool saved, with its reply written to the conversation.
 * A request opened by the open chat has no continuation; that chat is polling and needs nothing here.
 *
 * The tool result is `signInToolResult`, which is built from the row and carries no credential.
 */
export function createSignInResumer(deps: {
  database: Database;
  resumeResponsibility(
    ownerUserId: string,
    runId: string,
    result: string,
  ): Promise<unknown>;
  continueTurn(input: {
    ownerUserId: string;
    botId: string;
    snapshot: ApprovalContinuation;
    result: { content: string };
    messageId: string;
  }): Promise<{ replyText?: string }>;
  recordReply(input: {
    ownerUserId: string;
    channelId: string;
    botId: string;
    text: string;
    messageId: string;
  }): Promise<void>;
}) {
  return async (request: SignInRequestRecord) => {
    if (!request.continuation) return;
    const content = JSON.stringify(signInToolResult(request));
    const [waitingRun] = await deps.database
      .select({ id: responsibilityRuns.id })
      .from(responsibilityRuns)
      .where(
        and(
          eq(responsibilityRuns.status, "waiting"),
          sql`${responsibilityRuns.waiting}->>'signInRequestId' = ${request.id}`,
        ),
      )
      .limit(1);
    if (waitingRun) {
      await deps.resumeResponsibility(
        request.ownerUserId,
        waitingRun.id,
        content,
      );
      return;
    }
    const snapshot = parseApprovalContinuation(request.continuation);
    const messageId = `sign-in-result:${request.id}:${snapshot.toolCallId}`;
    const outcome = await deps.continueTurn({
      ownerUserId: request.ownerUserId,
      botId: request.botId,
      snapshot,
      result: { content },
      messageId,
    });
    const channelId = await channelFor(
      deps.database,
      request.ownerUserId,
      snapshot.threadId,
    );
    if (channelId && outcome.replyText)
      await deps.recordReply({
        ownerUserId: request.ownerUserId,
        channelId,
        botId: request.botId,
        text: outcome.replyText,
        messageId,
      });
    // A routine firing that was waiting on this sign-in is finished now, as after an approval.
    await deps.database
      .update(routineRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        error: null,
        waiting: null,
      })
      .where(
        and(
          eq(routineRuns.status, "waiting"),
          sql`${routineRuns.waiting}->>'signInRequestId' = ${request.id}`,
        ),
      );
  };
}

async function channelFor(
  database: Database,
  ownerUserId: string,
  threadId: string,
) {
  const [source] = await database
    .select({ channelId: intelligenceChannelMappings.channelId })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.userId, ownerUserId),
        eq(intelligenceChannelMappings.threadId, threadId),
      ),
    )
    .limit(1);
  return source?.channelId;
}

/**
 * Tell the owner a sign-in is waiting, on the channels this conversation is delivered to.
 *
 * Uses delivery's exported notify, which fans out to every binding (Slack, SMS) and every push device
 * the owner has. The message carries a link to the private form and nothing else: a credential must
 * never be answered in a chat reply, and the text says so.
 */
export function createSignInNotifier(deps: {
  database: Database;
  appUrl: string | undefined;
  notify(
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: "reply" | "question" | "approval";
      requestId?: string;
    },
  ): Promise<unknown>;
}) {
  return async (request: SignInRequestRecord) => {
    if (!request.threadId) return;
    const channelId = await channelFor(
      deps.database,
      request.ownerUserId,
      request.threadId,
    );
    if (!channelId) return;
    const link = deps.appUrl
      ? `${deps.appUrl.replace(/\/$/, "")}/sign-in/${request.id}`
      : `/sign-in/${request.id}`;
    await deps.notify(
      {
        ownerUserId: request.ownerUserId,
        channelId,
        agentId: request.botId,
        threadId: request.threadId,
      },
      {
        id: `sign-in:${request.id}`,
        kind: "question",
        requestId: request.id,
        text: `Your Bot needs you to sign in to ${request.origin}${request.reason ? ` (${request.reason})` : ""}. Open the private sign-in form: ${link}\nDo not reply with a password here.`,
      },
    );
  };
}
