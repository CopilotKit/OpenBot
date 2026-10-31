import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type GroupMessage,
  groupQueryOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import { markdownComponents } from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { ChannelAvatar } from "./avatar";
import { Composer, toAgentOptions } from "./composer";
import { TeamBotConsentCard } from "./team-bot-consent";

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the CopilotKit chat. Each Bot answers in a thread of its own on the server, so there is no one
 * agent for a browser run to bind to; the person posts a message, the server runs every addressed
 * Bot through the ordinary headless AG-UI path, and this draws what each of them said, attributed.
 * `@Name` in the composer addresses one Bot; otherwise every Bot answers, one after another.
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
  const messages = group.data?.messages ?? [];
  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );

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

  if (group.isPending) return null;
  if (group.isError)
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {group.error.message}
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          atBottom.current = isNearBottom(event.currentTarget);
        }}
        ref={viewportRef}
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-6">
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
              name={
                message.agentId
                  ? (names.get(message.agentId) ?? "A Bot no longer here")
                  : message.ownerUserId === me?.id
                    ? "You"
                    : "A teammate"
              }
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
      <div className="mx-auto w-full max-w-2xl shrink-0 pb-4">
        {send.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {send.error.message}
          </p>
        ) : null}
        <Composer
          agents={toAgentOptions(bots)}
          className="mt-auto w-full"
          commands={[]}
          compact
          disabled={bots.length === 0}
          pending={send.isPending || working}
          autoFocus
          onSubmit={async (draft) => {
            if (!draft.text) return;
            await send.mutateAsync({
              id: newId(),
              text: draft.text,
              agentId: draft.agentId,
            });
          }}
        />
      </div>
    </div>
  );
}

/** One attributed line: a person's bubble, and a Bot's named reply on the left. */
function GroupLine({
  message,
  name,
  answeredBy,
  mine,
}: {
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
}) {
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="text-xs font-medium text-muted-foreground">
              {name}
            </MessageHeader>
          )}
          <Bubble align={mine ? "end" : "start"} variant="muted">
            <BubbleContent>
              <span className="whitespace-pre-wrap">{message.text}</span>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </MessageRow>
    );
  return (
    <MessageRow align="start" data-speaker={message.agentId}>
      <div className="shrink-0 pt-0.5">
        <ChannelAvatar participantIds={[message.agentId]} size={24} />
      </div>
      <MessageContent>
        <MessageHeader className="text-xs font-medium text-muted-foreground">
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
              Asked a teammate for permission to use their own{" "}
              {message.consent.serverId} account.
            </p>
          )
        ) : message.status === "failed" ? (
          <p className="text-sm text-destructive" role="alert">
            {message.text || "This Bot couldn't answer."}
          </p>
        ) : (
          <Bubble
            align="start"
            aria-busy={message.status === "running"}
            variant="ghost"
            className="w-full"
          >
            <BubbleContent className="w-full">
              <Streamdown components={markdownComponents}>
                {message.text}
              </Streamdown>
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </MessageRow>
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
