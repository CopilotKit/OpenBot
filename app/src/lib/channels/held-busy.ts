import type { ChannelPage } from "./queries";

/*
 * A TURN THE ROSTER WAS TOLD OF IS NOT FORGOTTEN WHEN THE ROSTER IS READ AGAIN.
 *
 * A person's own turn runs in their browser, and the server holds no row that says so: their
 * browser announces it (`setChannelBusy`), the socket carries it to every tab, and the roster's
 * cache is patched. A read of the roster cannot say it, so the API leaves `busy` out rather than
 * answer false. But a read replaces the rows it answers, and a row the
 * server said nothing of lost the busy the socket had put on it: the conversation read as idle while
 * its Bot was still working.
 *
 * Found on OpenBot Cloud: a Bot ran three subtasks after the person gave it Slack. Giving an app
 * reads every query again (app-access-action.tsx), the card then carried the task on, and the
 * roster's read landed after the turn's busy event, or was read once more because of it
 * (`readAgainWhenLanded`). The conversation said "Working on 3 subtasks…" while its row in the list
 * said "1m". Anything that reads the roster again during a long turn did the same: a rename, a pin,
 * a new conversation, a Bot's line in a conversation the list has not loaded.
 *
 * So what the socket said is held here, and a read the server says nothing of busy in keeps it. Two
 * sources, kept apart:
 *
 * - `here`: a turn this tab is running, as `setChannelBusy` reports it. This tab knows exactly when
 *   it starts and ends, so it is held until it ends, whatever the socket does.
 * - `heard`: what the socket said, of this tab's turns or any other's. Forgotten when the socket
 *   connects again (`forgetHeardBusy`): an end said while it was down was never heard, and the read
 *   that follows the reconnect is the best word there is.
 */

const here = new Set<string>();
const heard = new Set<string>();

/** This tab began or ended a turn in a conversation. */
export function noteBusyHere(channelId: string, busy: boolean): void {
  if (busy) here.add(channelId);
  else here.delete(channelId);
}

/** The socket said a turn began or ended in a conversation. */
export function noteBusyHeard(channelId: string, busy: boolean): void {
  if (busy) heard.add(channelId);
  else heard.delete(channelId);
}

/** The socket connected again: what it said before may be missing an end, so it is let go of. */
export function forgetHeardBusy(): void {
  heard.clear();
}

/** Whether a turn is known to be running in this conversation, from this tab or the socket. */
export function heldBusy(channelId: string): boolean {
  return here.has(channelId) || heard.has(channelId);
}

/**
 * A page as the server answered it, with every row it said nothing of busy in marked busy when a
 * turn is known to be running there. A row the server answered busy for keeps its answer. The page
 * comes back as it was when nothing is held, so a read changes nothing it does not have to.
 */
export function keepHeldBusy(page: ChannelPage): ChannelPage {
  if (here.size === 0 && heard.size === 0) return page;
  let changed = false;
  const channels = page.channels.map((channel) => {
    if (channel.busy !== undefined || !heldBusy(channel.id)) return channel;
    changed = true;
    return { ...channel, busy: true };
  });
  return changed ? { ...page, channels } : page;
}

/** For tests: forget everything held, as a fresh tab would. */
export function resetHeldBusy(): void {
  here.clear();
  heard.clear();
}
