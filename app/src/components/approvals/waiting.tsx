import { offersStandingRule } from "@openbot/shared/standing-rule";
import {
  approvalDetails,
  approvalPhrase,
  approvalWords,
} from "@openbot/shared/tool-name";
import {
  IconDots,
  IconHandStop,
  IconMessageQuestion,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { ShareDetails, shareOf } from "@/components/approvals/share-details";
import { PageRows } from "@/components/layout/page-shell";
import {
  BoardRow,
  ROW_MENU_WIDTH,
  RowMenu,
} from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
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
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalDecision,
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
  dismissPersonQuestionMutationOptions,
} from "@/lib/approvals";
import { readFailure } from "@/lib/read-failure";
import { relativeTime } from "@/lib/relative-time";
import type { WaitingWhere } from "@/lib/tasks/groups";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

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
    failure: readFailure(inbox),
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
            {failureSaid(answer.error)}
          </p>
        ) : null}
      </ItemFooter>
    </Item>
  );
}

/**
 * What an approval would send, a labelled line each: "Text: hello". Nothing when it sends nothing
 * the title has not said already, as a click does: its ref and snapshot are handles for the model.
 *
 * A share reads as its card in the conversation reads: who reads it, in a sentence, and the whole
 * text. Its own fields (the audience's key, a count of recipients, the text's fingerprint) are the
 * server's, and listed here as "Audience", "Recipients" and "Preview" they said less than the card.
 */
function ApprovalDetails({
  action,
  className,
}: {
  action: WaitingRequest["action"];
  className?: string;
}) {
  if (shareOf(action))
    return <ShareDetails action={action} className={className} />;
  const details = approvalDetails(action.args);
  if (details.length === 0) return null;
  return (
    <dl
      aria-label="What it would send"
      className={cn(
        "max-h-52 space-y-1 overflow-auto rounded bg-muted p-3 text-xs",
        className,
      )}
    >
      {details.map((detail) => (
        <div key={detail.label}>
          <dt className="font-medium">{detail.label}</dt>
          <dd className="whitespace-pre-wrap break-words text-muted-foreground">
            {detail.value}
          </dd>
        </div>
      ))}
    </dl>
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
  // A share says who it goes to in its title, as its card does: "wants to hand this to Ledger Bot".
  const share = shareOf(request.action) !== null;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconHandStop />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">
          {botName} wants to{" "}
          {share ? approvalPhrase(request.action) : words.action}
        </ItemTitle>
        {share ? null : (
          <ItemDescription className="line-clamp-none break-all">
            {words.place}
          </ItemDescription>
        )}
        {request.action.policy ? (
          <p className="text-sm">
            {request.action.policy.behaviour === "hand_off"
              ? "Handed to you: "
              : ""}
            {request.action.policy.reason}
          </p>
        ) : null}
        <ApprovalDetails action={request.action} className="mt-1" />
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
            <>
              <Button
                disabled={decision.isPending}
                onClick={() =>
                  decision.mutate({
                    id: request.id,
                    choice: "allow_conversation",
                  })
                }
                size="sm"
                variant="outline"
              >
                Allow for this conversation
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
            </>
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
          {failureSaid(decision.error)}
        </p>
      ) : null}
    </Item>
  );
}

/**
 * The waiting questions and actions under each Bot's header on the Needs you board, questions first,
 * each with when it was asked so the header can say how long it has waited.
 *
 * `heldByTask` names a conversation one of the person's tasks runs in. What waits there is the task
 * waiting, and the board lists it once, as the task, the way the badge counts it: listed here too,
 * one question read as two rows and "2 waiting" beside a badge of 1.
 */
export function useWaitingByBot(
  agentId: string | undefined,
  heldByTask: (where: WaitingWhere) => boolean = () => false,
) {
  const waiting = useWaiting(agentId);
  const byBot = new Map<string, { rows: ReactNode[]; times: string[] }>();
  const add = (botId: string, row: ReactNode, at: string) => {
    const group = byBot.get(botId) ?? { rows: [], times: [] };
    group.rows.push(row);
    group.times.push(at);
    byBot.set(botId, group);
  };
  for (const question of waiting.questions.filter(
    (question) =>
      !heldByTask({
        channelId: question.channelId,
        threadId: question.threadId,
      }),
  ))
    add(
      question.conversationBotId ?? question.botId,
      <QuestionBoardRow key={`question-${question.id}`} question={question} />,
      question.createdAt,
    );
  for (const request of waiting.pending.filter(
    (request) => !heldByTask({ threadId: request.action.threadId }),
  ))
    add(
      request.action.botId,
      <RequestBoardRow key={`request-${request.id}`} request={request} />,
      request.createdAt,
    );
  return { error: waiting.error, failure: waiting.failure, byBot };
}

/**
 * A question on the board: one line, and Answer (or a click on it) opens a dialog with the whole
 * question, why the Bot stopped, and the box to answer in. A question can run to a paragraph, and a
 * dialog gives it room without stretching the list.
 */
/**
 * A question, answered in the conversation it was asked in: Answer and the row itself open it, where
 * the question waits above the composer. A question with no conversation on record is answered in a
 * dialog instead.
 */
function QuestionBoardRow({ question }: { question: WaitingQuestion }) {
  const navigate = useNavigate();
  const [answering, setAnswering] = useState(false);
  const { channelId } = question;
  const open = () =>
    channelId
      ? navigate({ to: "/channel/$channelId", params: { channelId } })
      : setAnswering(true);
  const dismiss = useMutation(
    dismissPersonQuestionMutationOptions(queryClient),
  );
  return (
    <>
      <BoardRow
        actions={
          <>
            <Button onClick={open} size="sm">
              Answer
            </Button>
            {/* Put it down unanswered: the Bot is not resumed, and nothing is sent to it. */}
            <Button
              aria-label={`Dismiss ${question.question}`}
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate({ id: question.id })}
              size="icon-sm"
              variant="ghost"
            >
              <IconX />
            </Button>
          </>
        }
        detail={question.why}
        icon={<IconMessageQuestion />}
        meta={[
          dismiss.error ? (
            <span className="text-destructive" key="error" role="alert">
              {failureSaid(dismiss.error)}
            </span>
          ) : null,
        ]}
        onSelect={open}
        title={question.question}
        waiting
      />
      <AnswerDialog
        onOpenChange={setAnswering}
        open={answering}
        question={question}
      />
    </>
  );
}

/** Whether the send shortcut is ⌘ or Ctrl, as the person's keyboard says it. */
const MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Answering a Bot's question, laid out as a reply: who asked and when, the question itself as the
 * heading with the Bot's reason under it, and one box to answer in with Send in its corner. ⌘↵ or
 * Ctrl↵ sends; Escape or the close button puts it away with nothing sent.
 */
function AnswerDialog({
  question,
  open,
  onOpenChange,
}: {
  question: WaitingQuestion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const agents = useQuery(agentListQueryOptions());
  const asker = question.conversationBotId ?? question.botId;
  const bot = agents.data?.find((agent) => agent.id === asker);
  const name = bot?.name ?? "Your Bot";
  const ready = text.trim().length > 0 && !answer.isPending;
  const send = () => {
    if (!ready) return;
    answer.mutate(
      { id: question.id, response: text },
      { onSuccess: () => onOpenChange(false) },
    );
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader className="gap-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <BotOrb name={name} seed={bot?.avatarSeed || asker} size={20} />
            <span className="font-medium text-foreground">{name}</span>
            <span aria-hidden>·</span>
            <span>asked {relativeTime(question.createdAt)}</span>
          </div>
          <DialogTitle className="whitespace-pre-wrap font-medium text-base leading-snug">
            {question.question}
          </DialogTitle>
          {question.why ? (
            <DialogDescription className="whitespace-pre-wrap">
              {question.why}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {name} stopped until you answer.
            </DialogDescription>
          )}
        </DialogHeader>
        <InputGroup>
          <InputGroupTextarea
            aria-label="Your answer"
            autoFocus
            className="min-h-28"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={`Reply to ${name}`}
            value={text}
          />
          <InputGroupAddon align="block-end">
            {answer.error ? (
              <InputGroupText className="text-destructive text-xs" role="alert">
                {failureSaid(answer.error)}
              </InputGroupText>
            ) : (
              <InputGroupText className="gap-1 font-normal text-xs">
                {/* Keys drawn as the Settings shortcuts are, so the glyphs sit centred on the row. */}
                {[MAC ? "⌘" : "Ctrl", "↵"].map((key) => (
                  <kbd
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-muted px-1 font-sans text-[11px] text-muted-foreground leading-none"
                    key={key}
                  >
                    {key}
                  </kbd>
                ))}
                <span className="ml-0.5">to send</span>
              </InputGroupText>
            )}
            <InputGroupButton
              className="ml-auto"
              disabled={!ready}
              onClick={send}
              size="sm"
              variant="default"
            >
              {answer.isPending ? "Sending…" : "Send answer"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The answers to an action waiting on the person, as a board row offers them: Deny and Allow, with
 * Allow for this conversation and Always allow here in the menu; for a hand-off, Don't do it and I
 * did it myself. The action's own row and the row of a task waiting on it both answer with these.
 */
function RequestAnswers({
  request,
  more = null,
}: {
  request: WaitingRequest;
  /** Menu items of the row it answers on (a task's Mark done and Open), put in this one's menu. */
  more?: ReactNode;
}) {
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const words = approvalWords(request.action);
  const handOff = request.action.policy?.behaviour === "hand_off";
  const decide = (choice: ApprovalDecision) =>
    decision.mutate({ id: request.id, choice });
  return (
    <>
      {decision.error ? (
        <span className="text-destructive text-xs" role="alert">
          {failureSaid(decision.error)}
        </span>
      ) : null}
      {handOff ? (
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
              <DropdownMenuContent align="end" className={ROW_MENU_WIDTH}>
                <DropdownMenuItem
                  disabled={decision.isPending}
                  onClick={() => decide("allow_conversation")}
                >
                  Allow for this conversation
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={decision.isPending}
                  onClick={() => decide("allow_always")}
                >
                  Always allow here
                </DropdownMenuItem>
                {more ? (
                  <>
                    <DropdownMenuSeparator />
                    {more}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : more ? (
            <RowMenu label={`More for ${words.action}`}>{more}</RowMenu>
          ) : null}
        </>
      )}
      {handOff && more ? (
        <RowMenu label={`More for ${words.action}`}>{more}</RowMenu>
      ) : null}
    </>
  );
}

/** Why an action waits on the person, in the words its policy gives, for a row's quiet line. */
function requestReason(request: WaitingRequest): ReactNode {
  const { policy } = request.action;
  if (!policy) return null;
  return (
    <span key="why">
      {policy.behaviour === "hand_off" ? "Handed to you: " : ""}
      {policy.reason}
    </span>
  );
}

/**
 * An action on the board: what it wants to do and where, with its answers on the right
 * (`RequestAnswers`). Where it acts and what it would send are always on screen, whole: nobody
 * allows something they were not shown.
 */
function RequestBoardRow({ request }: { request: WaitingRequest }) {
  const words = approvalWords(request.action);
  /*
   * A share is titled as its card is, who it goes to included: "Hand this to Ledger Bot". Split as
   * an action and its place, it read "Hand this to" over "Ledger Bot".
   */
  const share = shareOf(request.action) !== null;
  const said = share ? approvalPhrase(request.action) : words.action;
  const action = said.charAt(0).toUpperCase() + said.slice(1);
  return (
    <BoardRow
      actions={<RequestAnswers request={request} />}
      detail={share ? null : words.place}
      icon={<IconHandStop />}
      meta={[requestReason(request)]}
      more={<ApprovalDetails action={request.action} />}
      open
      title={action}
      waiting
      wholeDetail
    />
  );
}

/**
 * Answer, for a question a task waits on, from the board: the dialog with the whole question and
 * the box to answer in, so the person answers without opening the thread. And Dismiss beside it.
 */
function QuestionAnswers({
  question,
  more = null,
}: {
  question: WaitingQuestion;
  /** Menu items of the row it answers on (a task's Mark done and Open), in a menu after Dismiss. */
  more?: ReactNode;
}) {
  const [answering, setAnswering] = useState(false);
  const dismiss = useMutation(
    dismissPersonQuestionMutationOptions(queryClient),
  );
  return (
    <>
      {dismiss.error ? (
        <span className="text-destructive text-xs" role="alert">
          {failureSaid(dismiss.error)}
        </span>
      ) : null}
      <Button onClick={() => setAnswering(true)} size="sm">
        Answer
      </Button>
      <Button
        aria-label={`Dismiss ${question.question}`}
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate({ id: question.id })}
        size="icon-sm"
        variant="ghost"
      >
        <IconX />
      </Button>
      {more ? (
        <RowMenu label={`More for ${question.question}`}>{more}</RowMenu>
      ) : null}
      <AnswerDialog
        onOpenChange={setAnswering}
        open={answering}
        question={question}
      />
    </>
  );
}

/**
 * What a task's row on the board answers with: the controls of the wait it stands for. A question or
 * an action waiting in a task's own conversation is listed once, as the task's row, and that row
 * carries its answers, so the person answers it there without opening the thread.
 */
export type HeldAnswer = {
  /** Given the row's folded menu items, or null while they are buttons on the row. */
  actions: (more: ReactNode | null) => ReactNode;
  meta: ReactNode[];
  more?: ReactNode;
};

/**
 * For each task, the wait inside its conversation and how its row answers it, or undefined when
 * nothing waits there. An action waiting is answered first, since the task cannot go on without it;
 * then a question.
 */
export function useHeldAnswers(): (task: {
  channelId: string;
  threadId: string | null;
}) => HeldAnswer | undefined {
  const waiting = useWaiting(undefined);
  return (task) => {
    const request = task.threadId
      ? waiting.pending.find(
          (pending) => pending.action.threadId === task.threadId,
        )
      : undefined;
    if (request)
      return {
        actions: (more) => <RequestAnswers more={more} request={request} />,
        meta: [requestReason(request)],
        more: <ApprovalDetails action={request.action} />,
      };
    const question = waiting.questions.find(
      (asked) =>
        asked.channelId === task.channelId ||
        (task.threadId !== null && asked.threadId === task.threadId),
    );
    if (question)
      return {
        actions: (more) => <QuestionAnswers more={more} question={question} />,
        meta: question.why ? [<span key="why">{question.why}</span>] : [],
      };
    return undefined;
  };
}

/**
 * The waiting questions and actions as rows, questions first, for a card that may hold more. One
 * held by a task (`heldByTask`) is left to that task's own row.
 */
export function useWaitingRows(
  agentId: string | undefined,
  heldByTask: (where: WaitingWhere) => boolean = () => false,
) {
  const waiting = useWaiting(agentId);
  const botName = useBotNames();
  return {
    error: waiting.error,
    rows: [
      ...waiting.questions
        .filter(
          (question) =>
            !heldByTask({
              channelId: question.channelId,
              threadId: question.threadId,
            }),
        )
        .map((question) => (
          <QuestionRow
            botName={botName(question.botId)}
            key={`question-${question.id}`}
            question={question}
          />
        )),
      ...waiting.pending
        .filter((request) => !heldByTask({ threadId: request.action.threadId }))
        .map((request) => (
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
export function WaitingForYou({
  agentId,
  heldByTask,
}: {
  agentId?: string;
  /** Leaves out what waits inside a task, for a list that shows the task itself. */
  heldByTask?: (where: WaitingWhere) => boolean;
}) {
  const { error, rows } = useWaitingRows(agentId, heldByTask);
  return (
    <>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {failureSaid(error)}
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
