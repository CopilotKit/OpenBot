import { useEffect, useRef } from "react";
import {
  onComputerActivity,
  onComputerActivityWithdrawn,
} from "@/lib/copilot/computer-activity";

/**
 * The live screen opening itself beside a conversation, once per run, and closing again when the
 * call that opened it turns out to have been refused.
 *
 * A HOOK RATHER THAN AN EFFECT IN THE ROUTE, because what it decides is worth stating in tests
 * without a router, a channel and a chat transcript around it. The route keeps what is genuinely
 * its own: the pane is a URL flag it shares with the Bot's profile.
 *
 * The person's pane comes first. It does not open over something they opened (`busy`), it does not
 * reopen what they are already watching, and a run they closed stays closed for the rest of it.
 */
export function useAutoWatchScreen({
  botId,
  watching,
  busy,
  open,
  close,
}: {
  botId: string | undefined;
  /** The pane is currently showing this Bot's screen. */
  watching: boolean;
  /** The pane is showing something else the person asked for, which auto-open must not take. */
  busy: boolean;
  open: () => void;
  close: () => void;
}): { dismiss: () => void } {
  /** The run the Bot is in, so a dismissal can name the one it applies to. */
  const run = useRef<number | null>(null);
  const dismissed = useRef<number | null>(null);
  /**
   * The announcement this pane opened for, or null when it opened for nothing.
   *
   * Only this call may close it again. A pane the person opened never has one, and a pane showing
   * a page some earlier call loaded holds that call's announcement rather than a later one's.
   */
  const openedFor = useRef<number | null>(null);

  // Read inside subscriptions that outlive the render they were made in.
  const latest = useRef({ watching, busy, open, close });
  latest.current = { watching, busy, open, close };

  useEffect(() => {
    if (!botId) return;
    const stopActivity = onComputerActivity((activity) => {
      if (activity.botId !== botId) return;
      run.current = activity.epoch;
      if (dismissed.current === activity.epoch) return;
      const { watching: isWatching, busy: isBusy, open: show } = latest.current;
      if (isWatching || isBusy) return;
      openedFor.current = activity.announcement;
      show();
    });
    const stopWithdrawals = onComputerActivityWithdrawn((withdrawal) => {
      if (withdrawal.botId !== botId) return;
      if (openedFor.current !== withdrawal.announcement) return;
      openedFor.current = null;
      latest.current.close();
    });
    return () => {
      stopActivity();
      stopWithdrawals();
    };
  }, [botId]);

  return {
    dismiss: () => {
      dismissed.current = run.current;
      openedFor.current = null;
    },
  };
}
