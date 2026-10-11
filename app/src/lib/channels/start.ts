import {
  MutationObserver,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import {
  createGroupMutationOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import { newId } from "@/lib/new-id";
import {
  createChannelMutationOptions,
  deleteChannelMutationOptions,
} from "./mutations";
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
 * The record is told before the channel exists, the way the routed path records before a channel is
 * pinned, and its answer is thrown away: the person already decided and nothing here may change
 * that. Failing to write the row must not stop the conversation, so a rejection is swallowed whole.
 * Pure so the sequence can be tested; the hook below binds it to the real calls.
 */
export async function startWithChosen(input: {
  agentId: string;
  text: string;
  record: (text: string, agentId: string) => Promise<unknown>;
  start: (agentId: string, text: string) => Promise<void>;
}): Promise<void> {
  await input.record(input.text, input.agentId).catch(() => undefined);
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
 * Start a channel from a just-submitted first message, then navigate there.
 *
 * Ordering matters: create, seed the channel cache, stash the first message, then navigate. That
 * keeps the first message visible while the channel thread joins.
 */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const createGroup = useMutation(createGroupMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));

  const start = async (agentId: string, text: string) => {
    const channel = await createChannel.mutateAsync([agentId]);
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    stashFirstMessage(channel.id, text);
    await navigate({
      params: { channelId: channel.id },
      replace: true,
      to: "/channel/$channelId",
    });
  };

  const startGroup = (agentIds: string[], text: string) =>
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
        ).mutate({ id: newId(), text: message, agentId: null }),
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
    startChosen: (agentId: string, text: string) =>
      startWithChosen({ agentId, text, record: routeMessage, start }),
  };
}
