import type { Message } from "@ag-ui/core";
import { useEffect, useRef, useState } from "react";
import { BotBuddy } from "@/components/agents/bot-buddy";
import { useBotLook } from "@/components/agents/bot-look";
import { ChooseBuddyButton } from "@/components/bot-profile/buddy";
import type { AgentProfile } from "@/lib/agents/queries";
import { conversationActivity } from "@/lib/buddies/activity";
import type { BuddyActivity } from "@/lib/buddies/buddy";

/** How long the buddy stays to celebrate a finished turn, in milliseconds. */
const DONE_MS = 2500;

/** The buddy's size beside the composer. */
const SIZE = 88;

/**
 * What the Bot's buddy plays in its conversation: `conversationActivity`, and "done" for a moment
 * after a turn ends.
 */
export function useConversationBuddyActivity(input: {
  busy: boolean;
  waiting: boolean;
  messages: readonly Message[];
}): BuddyActivity {
  const now = conversationActivity(input);
  const [done, setDone] = useState(false);
  const wasBusy = useRef(input.busy);
  useEffect(() => {
    const finished = wasBusy.current && !input.busy;
    wasBusy.current = input.busy;
    if (input.busy) {
      setDone(false);
      return;
    }
    if (!finished) return;
    setDone(true);
    const timer = window.setTimeout(() => setDone(false), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [input.busy]);
  return now === "idle" && done ? "done" : now;
}

/**
 * The conversation's Bot as its buddy, standing on the composer's right end while it does something:
 * thinking, working, talking, waiting on the person, and a moment after it is done. At rest it steps
 * away, so it never sits over the end of an answer. Clicking it chooses another buddy.
 */
export function ConversationBuddy({
  bot,
  activity,
}: {
  bot: Pick<AgentProfile, "id" | "name" | "avatarSeed" | "buddy">;
  activity: BuddyActivity;
}) {
  if (useBotLook() !== "buddy" || activity === "idle") return null;
  return (
    <div className="fade-in-0 slide-in-from-bottom-3 animate-in duration-300">
      <ChooseBuddyButton agent={bot}>
        <BotBuddy
          activity={activity}
          bare
          name={bot.name}
          seed={bot.avatarSeed}
          size={SIZE}
        />
      </ChooseBuddyButton>
    </div>
  );
}
