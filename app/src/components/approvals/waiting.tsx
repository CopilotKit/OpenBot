import { offersStandingRule } from "@openbot/shared/standing-rule";
import { approvalWords } from "@openbot/shared/tool-name";
import { IconHandStop, IconMessageQuestion } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";

type WaitingQuestion = ApprovalInboxData["questions"][number];
type WaitingRequest = ApprovalInboxData["requests"][number];

/**
 * What waits on the person in the approval inbox, for one Bot or for all of them: the questions its
 * Bots asked, and the actions waiting on a decision. A question asked during a hand-off belongs to
 * the Bot whose conversation it is.
 */
function useWaiting(agentId: string | undefined) {
  const inbox = useQuery(approvalInboxOptions());
  const ours = (botId: string) => agentId === undefined || botId === agentId;
  return {
    error: inbox.error,
    questions: (inbox.data?.questions ?? []).filter((question) =>
      ours(question.conversationBotId ?? question.botId),
    ),
    pending: (inbox.data?.requests ?? []).filter(
      (request) => request.status === "pending" && ours(request.action.botId),
    ),
  };
}

/** A question a Bot asked mid-run, answered on the row's own footer line. */
function QuestionRow({
  question,
  botName,
  inGroup = false,
}: {
  question: WaitingQuestion;
  botName: string;
  /** Under its Bot's header, which already names who asks. */
  inGroup?: boolean;
}) {
  const [text, setText] = useState("");
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconMessageQuestion />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">
          {inGroup
            ? question.question
            : `${botName} asks: ${question.question}`}
        </ItemTitle>
        {question.why ? (
          <ItemDescription className="line-clamp-none">
            {question.why}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {/* In from the edge by the icon and its gap, so the answer lines up with the question. */}
      <ItemFooter className="flex-col items-start pl-11">
        <Textarea
          aria-label="Your answer"
          onChange={(event) => setText(event.target.value)}
          placeholder="Your answer"
          value={text}
        />
        <Button
          disabled={answer.isPending || !text.trim()}
          onClick={() => answer.mutate({ id: question.id, response: text })}
          size="sm"
        >
          Send answer
        </Button>
        {answer.error ? (
          <p role="alert" className="text-sm text-destructive">
            {answer.error.message}
          </p>
        ) : null}
      </ItemFooter>
    </Item>
  );
}

/**
 * An action waiting on a decision, decided on the row's own footer line, in from the edge by the
 * icon and its gap so the buttons line up with the text, as a task's and an item's do beside it.
 */
function RequestRow({
  request,
  botName,
  inGroup = false,
}: {
  request: WaitingRequest;
  botName: string;
  /** Under its Bot's header, which already names who wants it. */
  inGroup?: boolean;
}) {
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const words = approvalWords(request.action);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconHandStop />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">
          {inGroup
            ? `Wants to ${words.action}`
            : `${botName} wants to ${words.action}`}
        </ItemTitle>
        <ItemDescription className="line-clamp-none break-all">
          {words.place}
        </ItemDescription>
        {request.action.policy ? (
          <p className="text-sm">
            {request.action.policy.behaviour === "hand_off"
              ? "Handed to you: "
              : ""}
            {request.action.policy.reason}
          </p>
        ) : null}
        <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
          {JSON.stringify(request.action.args, null, 2)}
        </pre>
      </ItemContent>
      {request.action.policy?.behaviour === "hand_off" ? (
        <ItemFooter className="flex-wrap justify-start pl-11">
          <Button
            disabled={decision.isPending}
            onClick={() =>
              decision.mutate({ id: request.id, choice: "handled" })
            }
            size="sm"
          >
            I did it myself
          </Button>
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate({ id: request.id, choice: "deny" })}
            size="sm"
            variant="outline"
          >
            Don't do it
          </Button>
        </ItemFooter>
      ) : (
        <ItemFooter className="flex-wrap justify-start pl-11">
          <Button
            disabled={decision.isPending}
            onClick={() =>
              decision.mutate({
                id: request.id,
                choice: "allow_once",
              })
            }
            size="sm"
          >
            Allow once
          </Button>
          {offersStandingRule(request.action) ? (
            <Button
              disabled={decision.isPending}
              onClick={() =>
                decision.mutate({
                  id: request.id,
                  choice: "allow_always",
                })
              }
              size="sm"
              variant="outline"
            >
              Always allow here
            </Button>
          ) : null}
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate({ id: request.id, choice: "deny" })}
            size="sm"
            variant="outline"
          >
            Deny
          </Button>
        </ItemFooter>
      )}
      {decision.error ? (
        <p role="alert" className="basis-full pl-11 text-sm text-destructive">
          {decision.error.message}
        </p>
      ) : null}
    </Item>
  );
}

/**
 * The waiting questions and actions as rows under each Bot's header, questions first: the Needs you
 * board's half that is blocked on the person (`components/needs-you/board.tsx`).
 */
export function useWaitingByBot(
  agentId: string | undefined,
  /** Under a header naming each Bot; a Bot's own page has none, so its rows name it. */
  grouped: boolean,
) {
  const waiting = useWaiting(agentId);
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  const byBot = new Map<string, ReactNode[]>();
  const add = (botId: string, row: ReactNode) =>
    byBot.set(botId, [...(byBot.get(botId) ?? []), row]);
  for (const question of waiting.questions)
    add(
      question.conversationBotId ?? question.botId,
      <QuestionRow
        botName={botName(question.botId)}
        inGroup={grouped}
        key={`question-${question.id}`}
        question={question}
      />,
    );
  for (const request of waiting.pending)
    add(
      request.action.botId,
      <RequestRow
        botName={botName(request.action.botId)}
        inGroup={grouped}
        key={`request-${request.id}`}
        request={request}
      />,
    );
  return { error: waiting.error, byBot };
}

/** The waiting questions and actions as rows, questions first, for a card that may hold more. */
export function useWaitingRows(agentId: string | undefined) {
  const waiting = useWaiting(agentId);
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  return {
    error: waiting.error,
    rows: [
      ...waiting.questions.map((question) => (
        <QuestionRow
          botName={botName(question.botId)}
          key={`question-${question.id}`}
          question={question}
        />
      )),
      ...waiting.pending.map((request) => (
        <RequestRow
          botName={botName(request.action.botId)}
          key={`request-${request.id}`}
          request={request}
        />
      )),
    ],
  };
}

/**
 * Questions and actions waiting on the person, one row each, decided where it is shown: the answer
 * box and the decision buttons sit on the row's own footer line. Given a Bot, only that Bot's. The
 * same requests the conversation draws inline, so a decision made in either place is the one
 * decision.
 */
export function WaitingForYou({ agentId }: { agentId?: string }) {
  const { error, rows } = useWaitingRows(agentId);
  return (
    <>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <PageRows>
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? <Separator /> : null}
              {row}
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </>
  );
}
