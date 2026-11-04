import { offersStandingRule } from "@openbot/shared/standing-rule";
import { approvalWords } from "@openbot/shared/tool-name";
import {
  IconDots,
  IconHandStop,
  IconMessageQuestion,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { BoardRow } from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  const words = approvalWords(request.action);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconHandStop />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">
          {botName} wants to {words.action}
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
 * The waiting questions and actions under each Bot's header on the Needs you board, questions first,
 * each with when it was asked so the header can say how long it has waited.
 */
export function useWaitingByBot(agentId: string | undefined) {
  const waiting = useWaiting(agentId);
  const byBot = new Map<string, { rows: ReactNode[]; times: string[] }>();
  const add = (botId: string, row: ReactNode, at: string) => {
    const group = byBot.get(botId) ?? { rows: [], times: [] };
    group.rows.push(row);
    group.times.push(at);
    byBot.set(botId, group);
  };
  for (const question of waiting.questions)
    add(
      question.conversationBotId ?? question.botId,
      <QuestionBoardRow key={`question-${question.id}`} question={question} />,
      question.createdAt,
    );
  for (const request of waiting.pending)
    add(
      request.action.botId,
      <RequestBoardRow key={`request-${request.id}`} request={request} />,
      request.createdAt,
    );
  return { error: waiting.error, byBot };
}

/** A question on the board: one line, and Answer opens the box to reply in under it. */
function QuestionBoardRow({ question }: { question: WaitingQuestion }) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  return (
    <BoardRow
      actions={
        answering ? null : (
          <Button onClick={() => setAnswering(true)} size="sm">
            Answer
          </Button>
        )
      }
      detail={question.why}
      icon={<IconMessageQuestion />}
      more={
        <div className="flex flex-col items-start gap-2">
          <Textarea
            aria-label="Your answer"
            autoFocus
            onChange={(event) => setText(event.target.value)}
            placeholder="Your answer"
            value={text}
          />
          <div className="flex gap-1.5">
            <Button
              disabled={answer.isPending || !text.trim()}
              onClick={() => answer.mutate({ id: question.id, response: text })}
              size="sm"
            >
              {answer.isPending ? "Sending…" : "Send answer"}
            </Button>
            <Button
              onClick={() => setAnswering(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
          {answer.error ? (
            <p className="text-destructive text-sm" role="alert">
              {answer.error.message}
            </p>
          ) : null}
        </div>
      }
      open={answering}
      title={question.question}
      waiting
    />
  );
}

/**
 * An action on the board: what it wants to do and where, with Deny and Allow on the right, and
 * Always allow here in the menu. Where it acts and what it would send are always on screen, whole:
 * nobody allows something they were not shown.
 */
function RequestBoardRow({ request }: { request: WaitingRequest }) {
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const words = approvalWords(request.action);
  const handOff = request.action.policy?.behaviour === "hand_off";
  const decide = (choice: "allow_once" | "allow_always" | "deny" | "handled") =>
    decision.mutate({ id: request.id, choice });
  const action = words.action.charAt(0).toUpperCase() + words.action.slice(1);
  return (
    <BoardRow
      actions={
        handOff ? (
          <>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("deny")}
              size="sm"
              variant="outline"
            >
              Don't do it
            </Button>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("handled")}
              size="sm"
            >
              I did it myself
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("deny")}
              size="sm"
              variant="outline"
            >
              Deny
            </Button>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("allow_once")}
              size="sm"
            >
              Allow
            </Button>
            {offersStandingRule(request.action) ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={`More for ${words.action}`}
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <IconDots />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={decision.isPending}
                    onClick={() => decide("allow_always")}
                  >
                    Always allow here
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )
      }
      detail={words.place}
      icon={<IconHandStop />}
      meta={[
        request.action.policy ? (
          <span key="why">
            {handOff ? "Handed to you: " : ""}
            {request.action.policy.reason}
          </span>
        ) : null,
        decision.error ? (
          <span className="text-destructive" key="error" role="alert">
            {decision.error.message}
          </span>
        ) : null,
      ]}
      more={
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
          {JSON.stringify(request.action.args, null, 2)}
        </pre>
      }
      open
      title={action}
      waiting
      wholeDetail
    />
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
