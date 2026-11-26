import { useEffect, useId, useSyncExternalStore } from "react";
import {
  CarryOnGroup,
  hasCarriedOn,
  noteBlocked,
  wasSeenBlocked,
} from "./carry-on-group";
import { useConversation } from "./conversation";

export { carryOnMessage } from "./carry-on-group";

/**
 * Carrying on with the task an app card interrupted, once the app is ready, without the person
 * having to type their question again.
 *
 * WHY NOT THE HANDOFF RESUME. `handoff-resume.ts` answers a browser tool call that is still open:
 * the turn is paused inside the call, and resuming hands that call its result. An app card is drawn
 * from a call that has already answered — a refusal, or `show_app_access` — and the turn it was in
 * has ended with the Bot saying what it needs. There is nothing open to answer. What carries the
 * task on is simply the next turn, so that is what this sends: one short message, as the person,
 * through the same `ask` a button inside any transcript card uses.
 *
 * A MESSAGE RATHER THAN A HIDDEN RUN, deliberately. It is what the person would have typed, it
 * shows in the transcript so nobody wonders why the Bot started again, and it reaches the Bot with
 * the whole conversation behind it, so the Bot picks up the task it had stopped on. A run with no
 * new message would have the model guessing why it was woken.
 *
 * ONCE, AND ONLY WHILE NOTHING ELSE HAS HAPPENED. The card counts as the latest thing only while
 * the person has said nothing since it, has nothing queued, and the Bot is not working (see
 * `ChatTranscript`). A person who moved on is not dragged back to an older task. And it is sent
 * once per card, across re-renders, remounts and other tabs on this browser, by a mark kept in
 * `localStorage` under the tool call the card was drawn for, set before the message is sent.
 *
 * TOGETHER, WHEN A BOT ASKED FOR SEVERAL. The cards that are the latest thing carry on as one set
 * (`carry-on-group.ts`): one message naming every app, once the last of them is ready. Carried on
 * one by one, the first card's message moved the conversation on and the rest were never heard.
 *
 * SEEN, OR OFFERED. Cards that watched an app go from blocked to ready carry on by themselves: the
 * person was here, and the change is what they were waiting for. Cards drawn already ready, in a
 * conversation opened after the change (an admin approved overnight), cannot know the person still
 * wants the task done, so they offer Continue and leave it to them. So do cards some of which are
 * ready while others still wait, for a person who means to go on without the rest.
 */

/** Where an app card sits in its conversation, as the transcript knows it. */
export type CardPlace = {
  /** The tool call the card was drawn for: what "only once" is counted against. */
  toolCallId: string;
  /** Nothing said or queued since the card, and the Bot is not working. */
  latest: boolean;
};

/** For a card outside a conversation: nobody joins it, so it never sends or offers anything. */
const ALONE = new CarryOnGroup();

/**
 * Carry on when this card's app becomes ready, or offer to.
 *
 * `ready` is null until the card knows; only a known `false` counts as having seen the app blocked.
 * `blockedWhenAsked` says whether the app was out of reach when the Bot asked — what lets a card
 * drawn already ready offer Continue only where something changed since. Returns `carried` once
 * this card has carried on (here or in another tab), `inHand` while the conversation will carry on
 * with it (by itself, or from the Continue under it or a sibling), so the card never tells the
 * person to ask again, and `offer` when this card is the one to draw Continue.
 */
export function useCarryOn({
  place,
  ready,
  blockedWhenAsked,
  app,
}: {
  place: CardPlace | undefined;
  ready: boolean | null;
  blockedWhenAsked: boolean;
  app: string;
}): {
  carried: boolean;
  inHand: boolean;
  offer: (() => void) | null;
  /** This card saw its app out of reach, here, so ready now is a change. */
  sawBlocked: boolean;
} {
  const conversation = useConversation();
  const ask = conversation?.ask ?? null;
  const group = conversation?.carryOn ?? ALONE;
  const key = useId();
  // Re-read whenever any card of the conversation changes: whether this one offers depends on them.
  useSyncExternalStore(group.subscribe, group.snapshot, group.snapshot);

  const toolCallId = place?.toolCallId;
  /*
   * Seen blocked: kept rather than read off `ready`, so a card that saw the change still counts it
   * once ready, and kept per tool call for the tab (see `noteBlocked`), so it survives the trip to an
   * app's own page to type its key.
   */
  if (ready === false && toolCallId) noteBlocked(toolCallId);
  const sawBlocked = toolCallId ? wasSeenBlocked(toolCallId) : false;
  const joins = Boolean(ask && toolCallId && place?.latest);

  useEffect(() => {
    if (!joins || !toolCallId) {
      group.set(key, null, ask);
      return;
    }
    group.set(
      key,
      { toolCallId, app, ready, sawBlocked, blockedWhenAsked },
      ask,
    );
  }, [
    group,
    key,
    joins,
    toolCallId,
    app,
    ready,
    sawBlocked,
    blockedWhenAsked,
    ask,
  ]);
  // Leaves the set when it is drawn no more.
  useEffect(() => () => group.set(key, null, null), [group, key]);

  const carried = toolCallId ? hasCarriedOn(toolCallId) : false;
  return {
    carried,
    sawBlocked,
    inHand: joins,
    offer:
      joins && ready === true && !carried && group.view(key).offer
        ? () => group.carryOn()
        : null,
  };
}
