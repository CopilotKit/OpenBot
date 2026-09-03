import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { createChannelMutationOptions } from "./mutations";
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
 * Start a channel from a just-submitted first message, then navigate there.
 *
 * Ordering matters: create, seed the channel cache, stash the first message, then navigate. That
 * keeps the first message visible while the channel thread joins.
 */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));

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

  return {
    pending: createChannel.isPending,
    start,
    /** `start`, for a coworker the person chose: the choice is recorded first. */
    startChosen: (agentId: string, text: string) =>
      startWithChosen({ agentId, text, record: routeMessage, start }),
  };
}
