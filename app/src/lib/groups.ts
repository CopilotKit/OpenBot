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
import { attachmentUrl as storedAttachmentUrl } from "@openbot/shared/attachments";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import {
  type AgentChannel,
  channelKeys,
  channelOf,
} from "@/lib/channels/queries";
import type { SentFile } from "@/lib/computers/sent-file";

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
      organizationId(),
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
    ...(message.declined ? { declined: true } : {}),
    ...(message.answeredBy === undefined
      ? {}
      : { answeredBy: message.answeredBy }),
    ...(message.consent === undefined ? {} : { consent: message.consent }),
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            attachmentId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            url: storedAttachmentUrl(file.id),
          })),
        }
      : {}),
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
  /**
   * `queued`, `running`, `waiting`, `completed` or `failed`. The list can grow: a status this app
   * doesn't know draws the line as a plain reply.
   */
  status: string;
  createdAt: string;
  /** Why a waiting Bot is waiting, when it is, in words for the person reading. */
  reason?: string;
  /** A failed reply its person chose not to share: a choice, drawn as a notice and not an error. */
  declined?: true;
  /** For an answer relayed from another Bot through `message_bot`: which Bot answered. */
  answeredBy?: string;
  /** A Team Bot asking the person whose turn it was to use their own account. */
  consent?: { botId: string; serverId: string };
  /** The files a Bot sent from its computer with this reply, each drawn as its card. */
  files?: SentFile[];
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
          organizationId(),
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
 * so a turn the server gave up on before any Bot started does not poll for ever. The transcript
 * draws "Thinking" under that line for as long as this holds (`group-chat.tsx`).
 */
export function awaitingFirstReply(data: GroupConversation | undefined) {
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
        organizationId(),
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
        organizationId(),
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
        organizationId(),
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
        organizationId(),
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
