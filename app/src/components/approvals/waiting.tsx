import { IconHandStop, IconMessageQuestion } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { NeedsYouRows, useNeedsYou } from "@/components/needs-you/needs-you";
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
}: {
  question: WaitingQuestion;
  botName: string;
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
          {botName} asks: {question.question}
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
}: {
  request: WaitingRequest;
  botName: string;
}) {
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconHandStop />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">
          {botName} wants to{" "}
          {request.action.toolRef
            .replace(/^computer_|^host\//, "")
            .replaceAll("_", " ")}
        </ItemTitle>
        <ItemDescription className="line-clamp-none break-all">
          {request.action.scope}
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

/**
 * Everything one Bot is waiting on the person for, at the top of its page, in one card: its
 * questions and the actions waiting on a decision, then the tasks started from its check-ins, then
 * what its check-ins found, with Start and Hide. Nothing is drawn when nothing waits: the sidebar's
 * badge already said whether to look.
 */
export function BotNeedsYou({ agentId }: { agentId: string }) {
  const waiting = useWaitingRows(agentId);
  const list = useNeedsYou(agentId);
  if (
    waiting.rows.length + list.tasks.length + list.items.length === 0 &&
    !waiting.error &&
    !list.error
  )
    return null;
  return (
    <PageSection title="Needs you">
      {waiting.error || list.error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {(waiting.error ?? list.error)?.message}
        </p>
      ) : null}
      <NeedsYouRows items={list.items} lead={waiting.rows} tasks={list.tasks} />
    </PageSection>
  );
}
