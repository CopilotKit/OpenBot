import type { Message } from "@ag-ui/core";
import {
  type MessageReply,
  splitMessageReplies,
  withMessageReply,
} from "@openbot/shared/message-reply";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type GroupMessage,
  groupKeys,
  groupQueryOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import {
  BotMarkdown,
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { ChannelAvatar } from "./avatar";
import { RestoringTranscript } from "./chat-transcript";
import { Composer, toAgentOptions } from "./composer";
import { LinkedReply } from "./linked-reply";
import { MessageActions, ReplyQuote } from "./message-actions";
import { ReplyChainProvider } from "./reply-chain";
import { useOpenReplyChain } from "./reply-chain-context";
import { SentFileCard } from "./sent-file-card";
import { TeamBotConsentCard } from "./team-bot-consent";

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the CopilotKit chat. Each Bot answers in a thread of its own on the server, so there is no one
 * agent for a browser run to bind to; the person posts a message, the server runs every addressed
 * Bot through the ordinary headless AG-UI path, and this draws what each of them said, attributed.
 * `@Name` in the composer addresses one Bot; otherwise every Bot answers, one after another.
 *
 * A Bot here can ask the person something (`ask_person`), as it can in a conversation of its own.
 * The question waits above the composer, and what the person sends while it does is their answer,
 * unless they address another Bot. The server puts the answer in the transcript and runs the Bot
 * that asked on it (`approvals/questions.ts`).
 */
export function GroupChat({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const send = useMutation(
    sendGroupMessageMutationOptions(queryClient, channelId),
  );
  const bots = group.data?.bots ?? [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  // The people in it, as its members list names them: a person's line is headed with who sent it.
  const people = new Map(
    (group.data?.people ?? []).map((person) => [
      person.userId,
      person.name || person.email,
    ]),
  );
  const speakerName = (message: GroupMessage) => {
    if (message.agentId)
      return names.get(message.agentId) ?? "A Bot no longer here";
    if (message.ownerUserId === me?.id) return "You";
    // Use current members only, so a person's name is hidden when they leave.
    return people.get(message.ownerUserId) || "Someone who left";
  };
  const messages = group.data?.messages ?? [];
  const [replyTo, setReplyTo] = useState<MessageReply | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const speakers = new Map(
    messages.map((message) => [
      message.id,
      {
        author: speakerName(message),
        ...(message.agentId ? { botId: message.agentId } : {}),
      },
    ]),
  );
  const chainMessages: Message[] = messages.map((message) => ({
    id: message.id,
    role: message.agentId ? "assistant" : "user",
    content: message.text,
  }));
  const chooseReply = (reply: MessageReply) => {
    setReplyTo({ ...reply, ...speakers.get(reply.messageId) });
    setTimeout(
      () =>
        composerRef.current
          ?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
          ?.focus(),
      0,
    );
  };

  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );

  const inbox = useQuery(approvalInboxOptions());
  const question = groupQuestion(inbox.data, channelId);
  // The Bot whose conversation it is: for a hand-off, the one that handed the work on.
  const askerId = question?.conversationBotId ?? question?.botId;
  const asker = useQuery(agentListQueryOptions()).data?.find(
    (bot) => bot.id === askerId,
  );
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const answerTo = async (text: string, asked: WaitingQuestion) => {
    await answer.mutateAsync({ id: asked.id, response: text });
    // The answer is in the transcript now, and the Bot's turn on it is queued.
    await queryClient.invalidateQueries({
      queryKey: groupKeys.detail(channelId),
    });
  };
  /*
   * The inbox is read every 10 s, and a Bot that asks ends its turn on the question. Read again the
   * moment the Bots stop, so the question is above the composer when the reply that asks it is.
   */
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working)
      void queryClient.invalidateQueries({
        queryKey: approvalInboxOptions().queryKey,
      });
    wasWorking.current = working;
  }, [working, queryClient]);

  /*
   * LAND AT THE BOTTOM BEFORE THE FIRST PAINT, THEN FOLLOW ONLY A READER WHO IS STILL THERE.
   *
   * This was `scrollIntoView` in a `useEffect`, which runs after the browser has painted: every
   * group chat showed its top for a frame and then jumped. A layout effect moves it before paint.
   * And it followed every new line unconditionally, pulling somebody reading an earlier answer back
   * down each time a Bot spoke; `atBottom` is where the reader was at their last scroll.
   */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  // Once per mount, which is once per channel: the route keys `GroupChat` on its channel id.
  const landed = useRef(false);
  const newest = messages.at(-1);
  const newestIsMine = newest !== undefined && newest.ownerUserId === me?.id;
  const lastKey = `${messages.length}:${newest?.status ?? ""}`;
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null || lastKey === "0:") return;
    if (
      shouldFollowGroup({
        landed: landed.current,
        atBottom: atBottom.current,
        newestIsMine,
      })
    ) {
      element.scrollTop = element.scrollHeight;
      landed.current = true;
      atBottom.current = true;
    }
  }, [lastKey, newestIsMine]);

  if (group.isPending)
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <RestoringTranscript />
      </div>
    );
  // Only when nothing ever loaded: a refetch that fails keeps the conversation on screen.
  if (group.data === undefined)
    return (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 px-4 py-8"
        role="alert"
      >
        <p className="text-sm text-destructive">
          Couldn't load this conversation. Try again.
        </p>
        <Button
          disabled={group.isFetching}
          onClick={() => void group.refetch()}
          size="sm"
          variant="outline"
        >
          {group.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );

  return (
    <ReplyChainProvider
      messages={chainMessages}
      speakers={speakers}
      onReply={chooseReply}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            atBottom.current = isNearBottom(event.currentTarget);
          }}
          ref={viewportRef}
        >
          <div
            className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-6"
            data-transcript-column
          >
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Say something to {bots.map((bot) => bot.name).join(" and ")}.
                Every Bot answers in turn; start with @Name to ask just one.
              </p>
            ) : null}
            {messages.map((message) => (
              <GroupLine
                key={message.id}
                message={message}
                onReply={chooseReply}
                name={speakerName(message)}
                answeredBy={
                  message.answeredBy
                    ? (names.get(message.answeredBy) ?? "another Bot")
                    : undefined
                }
                mine={message.ownerUserId === me?.id}
              />
            ))}
          </div>
        </div>
        {/* The same column and the same compact composer as a conversation with one Bot. */}
        <div
          ref={composerRef}
          className="mx-auto w-full max-w-2xl shrink-0 pb-4"
        >
          {send.error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {send.error.message}
            </p>
          ) : null}
          {answer.error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {answer.error.message}
            </p>
          ) : null}
          {/* The same drawer a conversation with one Bot draws its question in. */}
          {question ? (
            <div
              className="mx-5 -mb-4 rounded-t-2xl border border-border border-b-0 bg-muted pb-4"
              data-slot="composer-drawer"
            >
              <QuestionNotice
                avatarSeed={asker?.avatarSeed || (askerId ?? question.id)}
                botName={
                  (askerId && names.get(askerId)) || asker?.name || "A Bot"
                }
                onAnswered={(text) => answerTo(text, question)}
                question={question}
              />
            </div>
          ) : null}
          {replyTo ? (
            <div className="mb-2">
              <ReplyQuote reply={replyTo} onCancel={() => setReplyTo(null)} />
            </div>
          ) : null}
          <Composer
            agents={toAgentOptions(bots)}
            className="relative mt-auto w-full"
            commands={[]}
            compact
            disabled={bots.length === 0}
            pending={send.isPending || answer.isPending || working}
            autoFocus
            onSubmit={async (draft) => {
              if (!draft.text) return;
              const agentId = draft.agentId ?? replyTo?.botId ?? null;
              const text = replyTo
                ? withMessageReply(draft.text, replyTo)
                : draft.text;
              if (question && (!agentId || agentId === askerId)) {
                await answerTo(text, question);
              } else {
                await send.mutateAsync({ id: newId(), text, agentId });
              }
              setReplyTo(null);
            }}
          />
        </div>
      </div>
    </ReplyChainProvider>
  );
}

/**
 * The newest open question a Bot asked in this group, from an inbox read. Each Bot here asks from a
 * thread of its own, so it is found by the conversation, not by a thread.
 */
export function groupQuestion(
  inbox: ApprovalInboxData | undefined,
  channelId: string,
): WaitingQuestion | undefined {
  return inbox?.questions.find((question) => question.channelId === channelId);
}

/** One attributed line: a person's bubble, and a Bot's named reply on the left. */
function GroupLine({
  message,
  name,
  answeredBy,
  mine,
  onReply,
}: {
  onReply: (reply: MessageReply) => void;
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
}) {
  const content = splitMessageReplies(message.text);
  const openChain = useOpenReplyChain();
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="text-xs font-medium text-muted-foreground">
              {name}
            </MessageHeader>
          )}
          <LinkedReply replies={content.replies}>
            <Bubble align={mine ? "end" : "start"} variant="muted">
              <BubbleContent
                render={
                  content.replies.length ? (
                    <button
                      type="button"
                      aria-label="View this reply thread"
                      onClick={() => {
                        const reply = content.replies[0];
                        if (reply) openChain?.(reply);
                      }}
                    />
                  ) : undefined
                }
                className={
                  content.replies.length ? "cursor-pointer" : undefined
                }
              >
                <span className="whitespace-pre-wrap">{content.text}</span>
              </BubbleContent>
            </Bubble>
          </LinkedReply>
        </MessageContent>
      </MessageRow>
    );
  return (
    <div className="[&_[data-slot=message-actions]]:ms-8">
      <MessageActions
        messageId={message.id}
        text={message.text}
        onReply={(reply) =>
          onReply({
            ...reply,
            author: name,
            botId: message.agentId ?? undefined,
          })
        }
        disabled={message.status !== "completed" || !message.text.trim()}
      >
        <MessageRow align="start" data-speaker={message.agentId}>
          <div className="shrink-0 pt-0.5">
            <ChannelAvatar participantIds={[message.agentId]} size={24} />
          </div>
          <MessageContent>
            <MessageHeader className="cursor-text px-0 text-xs font-medium text-muted-foreground">
              {name}
              {answeredBy ? ` · answer from ${answeredBy}` : null}
            </MessageHeader>
            {(message.status === "running" || message.status === "queued") &&
            !message.text ? (
              <p
                className="tool-line-running text-sm text-muted-foreground"
                role="status"
              >
                Thinking
              </p>
            ) : message.status === "waiting" ? (
              <p className="text-sm text-muted-foreground">
                {message.reason ?? "Waiting for your response."}{" "}
                <Link
                  className="underline"
                  params={{ agentId: message.agentId }}
                  to="/bots/$agentId"
                >
                  Open {name}
                </Link>
              </p>
            ) : message.consent ? (
              // Only the person whose account it asked for can answer; everyone else sees the ask.
              mine ? (
                <TeamBotConsentCard
                  botId={message.consent.botId}
                  message={message.text}
                  serverId={message.consent.serverId}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Asked someone else for permission to use their own{" "}
                  {message.consent.serverId} account.
                </p>
              )
            ) : message.status === "failed" ? (
              <p className="text-sm text-destructive" role="alert">
                {message.text || "This Bot couldn't answer."}
              </p>
            ) : (
              <>
                <Bubble
                  align="start"
                  aria-busy={message.status === "running"}
                  variant="ghost"
                  className="w-full"
                >
                  <BubbleContent className="w-full">
                    <BotMarkdown
                      components={markdownComponents}
                      plugins={markdownPlugins}
                      remarkPlugins={replyRemarkPlugins}
                    >
                      {message.text}
                    </BotMarkdown>
                  </BubbleContent>
                </Bubble>
                {/*
                 * The files the Bot sent from its computer with this reply, each as the card a
                 * conversation of its own draws, under its words: the reply is all a group keeps of a
                 * turn, so without them the file was a name in the words and nothing to open.
                 */}
                {message.files?.map((file) => (
                  <SentFileCard file={file} key={file.attachmentId} />
                ))}
              </>
            )}
          </MessageContent>
        </MessageRow>
      </MessageActions>
    </div>
  );
}

/**
 * Whether a scrolled element is close enough to its end to count as reading the newest line.
 *
 * Exported so it can be checked without mounting anything.
 */
export function isNearBottom(
  element: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 80,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  );
}

/**
 * Whether the group chat moves to its newest line.
 *
 * Always on opening, and always for the person's own message: they just sent it and are looking for
 * it. A Bot's line only for a reader already at the bottom, so somebody reading an earlier answer
 * keeps their place.
 *
 * Exported so it can be checked without mounting anything.
 */
export function shouldFollowGroup({
  landed,
  atBottom,
  newestIsMine,
}: {
  landed: boolean;
  atBottom: boolean;
  newestIsMine: boolean;
}): boolean {
  return !landed || atBottom || newestIsMine;
}
