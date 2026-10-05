import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";

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
      const response = await client(
        `/api/groups/${encodeURIComponent(channelId)}`,
        { fallback: "This group conversation could not be loaded." },
      );
      return (await response.json()) as GroupConversation;
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
      await client(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "POST",
        body: input,
        fallback: "Your message could not be sent to the group.",
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Start a group; the Bots answer in the order given. */
export function createGroupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await client("/api/groups", {
        method: "POST",
        body: { agentIds },
        fallback: "The group could not be started.",
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/** Add a person who has signed in here to a group this person is in. */
export function addGroupMemberMutationOptions(channelId: string) {
  return mutationOptions({
    mutationFn: async (email: string) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}/members`, {
        method: "POST",
        body: { email },
        fallback: "That person could not be added.",
      });
    },
  });
}

/** Leave a group, or (its creator) take someone else out of it. */
export function removeGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (userId: string) => {
      await client(
        `/api/groups/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE", fallback: "That person could not be removed." },
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
