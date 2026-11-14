import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  addConversationMember,
  createConversation,
  listConversationMembers,
  listConversationMessages,
  removeConversationMember,
  sendConversationMessage,
} from "@/lib/api/generated/conversations/conversations";
import type {
  ConversationMember,
  ConversationMessage,
} from "@/lib/api/generated/model";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import {
  type AgentChannel,
  channelKeys,
  channelOf,
} from "@/lib/channels/queries";

/** A key for one write, so a retry of it is recognised as the same write. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** The most the transcript shows: the newest lines, as the page always has. */
const TRANSCRIPT_LINES = 200;

/** Every page of a list, in order. A group's people and Bots are few; this reads them all. */
async function everyMember(channelId: string): Promise<ConversationMember[]> {
  const members: ConversationMember[] = [];
  let cursor: string | undefined;
  do {
    const page = await listConversationMembers(
      ORGANIZATION_ID,
      channelId,
      { limit: 100, ...(cursor ? { cursor } : {}) },
      { fallback: "This group conversation could not be loaded." },
    );
    members.push(...page.members);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return members;
}

/** A line as the API answers it, in the names the transcript draws. */
function groupMessageOf(
  channelId: string,
  message: ConversationMessage,
): GroupMessage {
  return {
    id: message.id,
    channelId,
    ownerUserId: message.personId ?? "",
    agentId: message.botId,
    text: message.text,
    status: message.status,
    createdAt: message.createdAt ?? "",
    ...(message.reason === undefined ? {} : { reason: message.reason }),
    ...(message.answeredBy === undefined
      ? {}
      : { answeredBy: message.answeredBy }),
    ...(message.consent === undefined ? {} : { consent: message.consent }),
  };
}

/** One line of a group conversation: a person's message (`agentId` null) or one Bot's reply. */
export type GroupMessage = {
  id: string;
  channelId: string;
  /** Who sent it, for a person's line; whose run it was, for a Bot's. */
  ownerUserId: string;
  agentId: string | null;
  text: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  createdAt: string;
  /** Why a waiting Bot is waiting, when it is. */
  reason?: string;
  /** For an answer relayed from another Bot through `message_bot`: which Bot answered. */
  answeredBy?: string;
  /** A Team Bot asking the person whose turn it was to use their own account. */
  consent?: { botId: string; serverId: string };
};
export type GroupPerson = {
  userId: string;
  email: string;
  name: string | null;
  /** Made the group; the one who may take others out of it. */
  creator: boolean;
};
export type GroupBot = { id: string; name: string };
export type GroupConversation = {
  bots: GroupBot[];
  people: GroupPerson[];
  messages: GroupMessage[];
};

export const groupKeys = {
  detail: (channelId: string) => ["groups", channelId] as const,
};

/**
 * The shared transcript. Bot turns run on the server with nobody's browser attached, so the page
 * polls while a turn is still owed an answer and stops once every Bot has spoken.
 */
export function groupQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.detail(channelId),
    queryFn: async (): Promise<GroupConversation> => {
      const [members, newestFirst] = await Promise.all([
        everyMember(channelId),
        listConversationMessages(
          ORGANIZATION_ID,
          channelId,
          { limit: TRANSCRIPT_LINES },
          { fallback: "This group conversation could not be loaded." },
        ),
      ]);
      return {
        bots: members
          .filter((member) => member.kind === "bot")
          .map((member) => ({ id: member.id, name: member.name ?? "" })),
        people: members
          .filter((member) => member.kind === "person")
          .map((member) => ({
            userId: member.id,
            email: member.email ?? "",
            name: member.name,
            creator: member.creator ?? false,
          })),
        // The API answers newest first. The transcript reads oldest first.
        messages: newestFirst.messages
          .map((message) => groupMessageOf(channelId, message))
          .reverse(),
      };
    },
    refetchInterval: (query) =>
      query.state.data?.messages.some(
        (message) =>
          message.status === "running" || message.status === "queued",
      ) || awaitingFirstReply(query.state.data)
        ? 1_500
        : false,
  });
}

/**
 * The last line is still a person's: the server has queued it but no Bot has started yet. Bounded,
 * so a turn the server gave up on before any Bot started does not poll for ever.
 */
function awaitingFirstReply(data: GroupConversation | undefined) {
  const last = data?.messages.at(-1);
  return (
    last !== undefined &&
    last.agentId === null &&
    Date.now() - Date.parse(last.createdAt) < 10 * 60_000
  );
}

export function sendGroupMessageMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      text: string;
      agentId: string | null;
    }) => {
      await sendConversationMessage(
        ORGANIZATION_ID,
        channelId,
        { id: input.id, text: input.text, botId: input.agentId },
        once(),
        { fallback: "Your message could not be sent to the group." },
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Start a group; the Bots answer in the order given. */
export function createGroupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const made = await createConversation(
        ORGANIZATION_ID,
        { botIds: agentIds, group: true },
        once(),
        { fallback: "The group could not be started." },
      );
      return channelOf(made.conversation);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/** Add a person who has signed in here to a group this person is in. */
export function addGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (email: string) => {
      await addConversationMember(
        ORGANIZATION_ID,
        channelId,
        { email },
        once(),
        { fallback: "That person could not be added." },
      );
    },
    // So the list of people shows them straight away.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Leave a group, or (its creator) take someone else out of it. */
export function removeGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (userId: string) => {
      await removeConversationMember(
        ORGANIZATION_ID,
        channelId,
        userId,
        once(),
        { fallback: "That person could not be removed." },
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupKeys.detail(channelId),
        }),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
      ]),
  });
}
