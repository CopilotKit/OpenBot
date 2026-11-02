import { useEffect, useRef, useState } from "react";
import { useConversation } from "./conversation";

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
 * SEEN, OR OFFERED. A card that watched the app go from blocked to ready carries on by itself: the
 * person was here, and the change is what they were waiting for. A card drawn already ready, in a
 * conversation opened after the change (an admin approved overnight), cannot know the person still
 * wants the task done, so it offers Continue and leaves it to them.
 */

/** Where an app card sits in its conversation, as the transcript knows it. */
export type CardPlace = {
  /** The tool call the card was drawn for: what "only once" is counted against. */
  toolCallId: string;
  /** Nothing said or queued since the card, and the Bot is not working. */
  latest: boolean;
};

const MARK = "openbot:carried-on:";

/** Marks kept here as well, for a browser that refuses `localStorage` (a private window, a policy). */
const carriedHere = new Set<string>();

function hasCarriedOn(toolCallId: string): boolean {
  if (carriedHere.has(toolCallId)) return true;
  try {
    return window.localStorage.getItem(MARK + toolCallId) !== null;
  } catch {
    return false;
  }
}

/** Mark this card as carried on. False when something already had: this caller must not send. */
function markCarriedOn(toolCallId: string): boolean {
  if (hasCarriedOn(toolCallId)) return false;
  carriedHere.add(toolCallId);
  try {
    window.localStorage.setItem(MARK + toolCallId, new Date().toISOString());
  } catch {
    // The in-memory mark still holds for this tab.
  }
  return true;
}

/** What is sent as the person when the task carries on. Short, and true whoever made it ready. */
export function carryOnMessage(app: string): string {
  return `${app} is ready now. Please carry on.`;
}

/**
 * Carry on when this card's app becomes ready, or offer to.
 *
 * `ready` is null until the card knows; only a known `false` counts as having seen the app blocked.
 * `blockedWhenAsked` says whether the app was out of reach when the Bot asked — what lets a card
 * drawn already ready offer Continue only where something changed since. Returns `carried` once
 * this card has carried on (here or in another tab), and `offer` when a Continue is worth drawing.
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
}): { carried: boolean; offer: (() => void) | null } {
  const ask = useConversation()?.ask;
  const sawBlocked = useRef(false);
  // Only re-renders this card once it has sent, so `carried` is read again.
  const [, rerender] = useState(0);
  useEffect(() => {
    if (ready === false) sawBlocked.current = true;
  }, [ready]);

  const toolCallId = place?.toolCallId;
  const carried = toolCallId ? hasCarriedOn(toolCallId) : false;
  const can = Boolean(ask && toolCallId && place?.latest && ready === true);

  const send = () => {
    if (!ask || !toolCallId || !markCarriedOn(toolCallId)) return;
    ask(carryOnMessage(app));
    rerender((count) => count + 1);
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (can && sawBlocked.current) sendRef.current();
  }, [can]);

  return {
    carried,
    offer:
      can && !carried && !sawBlocked.current && blockedWhenAsked ? send : null,
  };
}
