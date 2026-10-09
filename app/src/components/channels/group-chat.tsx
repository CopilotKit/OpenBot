import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  addGroupMemberMutationOptions,
  type GroupPerson,
  removeGroupMemberMutationOptions,
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

  // Follow the conversation down as lines arrive, the way the single-Bot transcript does.
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastKey = `${messages.length}:${messages.at(-1)?.status ?? ""}`;
  useEffect(() => {
    if (lastKey) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastKey]);

  if (group.isPending) return null;
  if (group.isError)
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {group.error.message}
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <div ref={endRef} />
        </div>
      </div>
      {/* The same column and the same compact composer as a conversation with one Bot. */}
      <div className="mx-auto w-full max-w-2xl shrink-0 pb-4">
        {send.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {send.error.message}
          </p>
        ) : null}
        <People
          channelId={channelId}
          me={me?.id}
          people={group.data?.people ?? []}
        />
        <AddPerson channelId={channelId} />
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
            {message.text || "This Bot could not answer."}
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

/** Invite another person who has signed in here. They see this whole conversation. */
function AddPerson({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const add = useMutation(addGroupMemberMutationOptions(channelId));
  if (!open)
    return (
      <div className="flex justify-end pb-2">
        <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
          Add a person
        </Button>
      </div>
    );
  return (
    <form
      className="flex items-center gap-2 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(email, {
          onSuccess: () => {
            setEmail("");
            setOpen(false);
          },
        });
      }}
    >
      <Input
        aria-label="Their email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Their email"
        type="email"
        value={email}
      />
      <Button disabled={!email.trim() || add.isPending} size="sm" type="submit">
        Add
      </Button>
      {add.error ? (
        <span className="text-sm text-destructive" role="alert">
          {add.error.message}
        </span>
      ) : null}
    </form>
  );
}

/** Who is in the group. The creator can take people out; anyone else can leave. */
function People({
  channelId,
  me,
  people,
}: {
  channelId: string;
  me: string | undefined;
  people: GroupPerson[];
}) {
  const queryClient = useQueryClient();
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const iCreated = people.some(
    (person) => person.creator && person.userId === me,
  );
  if (people.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 text-xs text-muted-foreground">
      <span>People:</span>
      {people.map((person) => {
        const self = person.userId === me;
        const removable = self ? !person.creator : iCreated;
        return (
          <span
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
            key={person.userId}
          >
            {self ? "You" : (person.name ?? person.email)}
            {removable ? (
              <button
                aria-label={
                  self ? "Leave this group" : `Remove ${person.email}`
                }
                className="hover:text-foreground"
                disabled={remove.isPending}
                onClick={() => remove.mutate(person.userId)}
                type="button"
              >
                {self ? "leave" : "×"}
              </button>
            ) : null}
          </span>
        );
      })}
      {remove.error ? (
        <span className="text-destructive" role="alert">
          {remove.error.message}
        </span>
      ) : null}
    </div>
  );
}
