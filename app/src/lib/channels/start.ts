import {
  MutationObserver,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import {
  createGroupMutationOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import { saveConversationModel } from "@/lib/models/mutations";
import type { ConversationModel } from "@/lib/models/queries";
import { newId } from "@/lib/new-id";
import {
  createChannelMutationOptions,
  deleteChannelMutationOptions,
} from "./mutations";
import { pendingStartPath, settlePendingStart } from "./pending-start";
import { channelKeys } from "./queries";
import { routeMessage } from "./route";

/**
 * Start a channel with a coworker the person chose themselves, and say so first.
 *
 * A conversation that was routed has a `channel.routed` row saying where it went and why; one whose
 * coworker the person picked must have one too, or the trail reads as if the row failed to write.
 * The home composer told the server about an `@` choice; a coworker picked in the To: field of
 * `/channel/new` — the sidebar's +, a coworker's card, its profile — was never told to anybody. The
 * two screens now share this one sequence: record, then start.
 *
 * The record is sent before the channel is asked for, the way the routed path records before a
 * channel is pinned, and its answer is thrown away: the person already decided and nothing here may
 * change that. Failing to write the row must not stop the conversation, so a rejection is swallowed
 * whole. And because nothing waits on its answer, nothing waits on it at all: it used to be awaited,
 * which put a whole round trip between send and the conversation opening for a row nobody reads.
 * Pure so the sequence can be tested; the hook below binds it to the real calls.
 */
export async function startWithChosen(input: {
  agentId: string;
  text: string;
  record: (text: string, agentId: string) => Promise<unknown>;
  start: (agentId: string, text: string) => Promise<void>;
}): Promise<void> {
  void input.record(input.text, input.agentId).catch(() => undefined);
  await input.start(input.agentId, input.text);
}

/**
 * Start a group from a just-submitted first message: create it with the Bots in the order they were
 * picked, give it the message, then open it. Pure so the order can be tested; nothing is sent or
 * opened when the group could not be made.
 *
 * A group exists to hold that first message, so one whose message did not send is discarded rather
 * than left in everybody's roster as an empty conversation. The send's own error is what the caller
 * sees (the composer keeps the draft for another try); a failed discard is swallowed, because the
 * person's problem is the message, and an empty group is the lesser leftover.
 */
export async function startGroupWith(input: {
  agentIds: string[];
  text: string;
  create: (agentIds: string[]) => Promise<{ id: string }>;
  send: (channelId: string, text: string) => Promise<void>;
  discard: (channelId: string) => Promise<void>;
  open: (channelId: string) => Promise<void>;
}): Promise<void> {
  const group = await input.create(input.agentIds);
  try {
    await input.send(group.id, input.text);
  } catch (error) {
    await input.discard(group.id).catch(() => undefined);
    throw error;
  }
  await input.open(group.id);
}

/**
 * Create a conversation, save the model and thinking effort picked for it, then open it with its
 * first message.
 *
 * The pick is saved before the conversation opens, because opening it is what sends the first
 * message, and that message must not run on a model or effort other than the one picked. A pick
 * that cannot be saved discards the conversation, which exists only to hold that message, and the
 * save's own error is what the caller sees, so the composer keeps the draft. Pure so the order can
 * be tested.
 */
export async function startWithModel(input: {
  /** Null, or both halves null, when everything is the default and nothing needs saving. */
  pick: ConversationModel | null;
  create: () => Promise<{ id: string }>;
  save: (channelId: string, pick: ConversationModel) => Promise<unknown>;
  discard: (channelId: string) => Promise<void>;
  open: (channelId: string) => Promise<void>;
}): Promise<void> {
  const channel = await input.create();
  const { pick } = input;
  if (pick && (pick.model !== null || pick.effort !== null)) {
    try {
      await input.save(channel.id, pick);
    } catch (error) {
      await input.discard(channel.id).catch(() => undefined);
      throw error;
    }
  }
  await input.open(channel.id);
}

/**
 * Start a channel from a just-submitted first message, then navigate there.
 *
 * Ordering matters: create, seed the channel cache, stash the first message, then navigate. That
 * keeps the first message visible while the channel thread joins.
 *
 * Started from a placeholder (`pendingId`, see `pending-start.ts`), the conversation replaces the
 * placeholder only while the person is still looking at it. Somebody who went elsewhere while it
 * was being made is not pulled back; the conversation is in their sidebar, and its first message
 * stays stashed until they open it, which is when it is sent. Going back to the placeholder opens
 * it too (`settlePendingStart`).
 */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const createGroup = useMutation(createGroupMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const discardFailedStart = useMutation(
    deleteChannelMutationOptions(queryClient, true),
  );

  const start = (
    agentId: string,
    text: string,
    /** A model and effort picked before the conversation existed, saved before its first message runs. */
    pick?: ConversationModel | null,
    /** The placeholder this was started behind, if any; see the hook's own comment. */
    pendingId?: string,
  ) =>
    startWithModel({
      pick: pick ?? null,
      create: async () => {
        const channel = await createChannel.mutateAsync([agentId]);
        queryClient.setQueryData(channelKeys.detail(channel.id), channel);
        return channel;
      },
      save: saveConversationModel,
      discard: async (channelId) => {
        await discardFailedStart.mutateAsync(channelId);
      },
      open: async (channelId) => {
        stashFirstMessage(channelId, text);
        if (pendingId !== undefined) {
          // Remembered whether or not they are looking, so coming back to the placeholder opens it.
          settlePendingStart(pendingId, channelId);
          if (router.state.location.pathname !== pendingStartPath(pendingId))
            return;
        }
        await navigate({
          params: { channelId },
          replace: true,
          to: "/channel/$channelId",
        });
      },
    });

  const startGroup = (
    agentIds: string[],
    text: string,
    /** The one Bot the first message is addressed to with `@`, or null for every Bot in turn. */
    agentId: string | null = null,
  ) =>
    startGroupWith({
      agentIds,
      text,
      create: async (ids) => {
        const channel = await createGroup.mutateAsync(ids);
        queryClient.setQueryData(channelKeys.detail(channel.id), channel);
        return channel;
      },
      // The group's id only exists once it is made, so the send's factory is bound here, per
      // group, and run through an observer rather than a hook created ahead of time.
      send: (channelId, message) =>
        new MutationObserver(
          queryClient,
          sendGroupMessageMutationOptions(queryClient, channelId),
        ).mutate({ id: newId(), text: message, agentId }),
      discard: async (channelId) => {
        await deleteChannel.mutateAsync(channelId);
      },
      open: (channelId) =>
        navigate({
          params: { channelId },
          replace: true,
          to: "/group/$channelId",
        }),
    });

  return {
    pending: createChannel.isPending || createGroup.isPending,
    /** Two or more Bots: a group, answering in the order given. */
    startGroup,
    start,
    /** `start`, for a coworker the person chose: the choice is recorded first. */
    startChosen: (
      agentId: string,
      text: string,
      pick?: ConversationModel | null,
      pendingId?: string,
    ) =>
      startWithChosen({
        agentId,
        text,
        record: routeMessage,
        start: (id, message) => start(id, message, pick, pendingId),
      }),
  };
}
