import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  DESKTOP_NOTIFICATIONS_STORAGE_KEY,
  parseDesktopNotificationsPreference,
  showDesktopNotification,
} from "@/lib/notifications/desktop";
import {
  type BotNotification,
  clearBotWaiting,
  useWaitingBots,
} from "@/lib/notifications/waiting";
import { Button } from "../ui/button";

/**
 * The corner of the screen where a Bot says it has stopped and is waiting for you.
 *
 * Deliberately the least of the three surfaces this fact has. The audit trail records the handover,
 * the Bot's own screen shows the prompt that answers it, and the sidebar keeps a marker until
 * somebody opens the Bot. This is the one that catches an eye that is elsewhere, and it is allowed
 * to be missed: it goes away on its own, and nothing depends on it having been read.
 *
 * A click goes to the Bot with its screen open, because the screen is where the prompt that unblocks
 * it lives. Sending somebody to a transcript would be sending them to the right conversation and the
 * wrong pane.
 */

/**
 * How long a toast stays.
 *
 * Long enough to notice out of the corner of an eye and act on, short enough that the corner of the
 * screen does not accumulate. It can afford to be short because the sidebar marker is the thing that
 * persists; nothing is lost when this goes.
 *
 * Counted by each card for itself rather than by the list that holds them. A timer owned by the list
 * has to be torn down whenever the list is rebuilt, and the list is rebuilt every time any Bot's
 * marker changes anywhere in the product: a second Bot asking, or the first one's marker being
 * cleared by somebody opening it, would cancel the countdown of a card already on screen and leave
 * it there for good. That is the opposite of what this surface promises, and because the cards take
 * pointer events, a stranded one goes on covering the corner of somebody's work.
 */
const VISIBLE_MS = 12_000;

const ENTRANCE_SECONDS = 0.2;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export function WaitingToasts() {
  const waiting = useWaitingBots();
  const navigate = useNavigate();
  const channels = useQuery(channelListQueryOptions());
  /**
   * The roster, for the name on the card.
   *
   * The channel list is not that. A channel is named after everybody in it, so in a channel with two
   * Bots it would put both names in front of somebody and say one of them was waiting. Read from the
   * roster the name belongs to instead, and fall back to the id, which is a poor label and an honest
   * one.
   */
  const agents = useQuery(agentListQueryOptions());
  /**
   * Which notifications have already been announced.
   *
   * Seeded from what was already outstanding when this mounted, and that seeding is the point. The
   * marker store survives a reload, so a set that started empty would greet somebody with a toast,
   * and a desktop notification, for every Bot that has ever gone unanswered, every time they opened
   * the app. Only what arrives while this is mounted is announced.
   */
  const [announced] = useState(
    () =>
      new Set(Object.values(waiting).map((notification) => notification.id)),
  );
  const [showing, setShowing] = useState<BotNotification[]>([]);

  const roster = agents.data;
  /** The Bot's name where the roster knows it. An id is a poor label, and better than none. */
  const nameOf = useCallback(
    (botId: string) =>
      roster?.find((agent) => agent.id === botId)?.name ?? botId,
    [roster],
  );

  /*
   * Re-running when the roster arrives is free, and refusing to would not be.
   *
   * `announced` is what stops a notification being told twice, so an extra run finds nothing new and
   * returns. Leaving the roster out of the dependencies to avoid those runs is the version that goes
   * wrong: the first notification of a session lands before the roster does, and the desktop
   * notification would then carry an id where a name should be.
   */
  useEffect(() => {
    const arrived = Object.values(waiting).filter(
      (notification) => !announced.has(notification.id),
    );
    if (arrived.length === 0) return;
    for (const notification of arrived) {
      announced.add(notification.id);
      // The operating system's own notification, only where somebody turned it on. See desktop.ts:
      // nothing here ever asks for the permission.
      if (desktopNotificationsWanted()) {
        showDesktopNotification(nameOf(notification.botId), notification);
      }
    }
    setShowing((current) => [...current, ...arrived]);
  }, [waiting, announced, nameOf]);

  const dismiss = (id: string) =>
    setShowing((current) =>
      current.filter((notification) => notification.id !== id),
    );

  const open = async (notification: BotNotification) => {
    dismiss(notification.id);
    // Cleared on the way, not on arrival. Opening the Bot is the answer to the question, and waiting
    // for the destination to render would leave the marker up if the navigation failed.
    clearBotWaiting(notification.botId);
    const channel = (channels.data ?? []).find((candidate) =>
      candidate.agentIds.includes(notification.botId),
    );
    if (channel) {
      await navigate({
        to: "/channel/$channelId",
        params: { channelId: channel.id },
        search: { watch: true },
      });
      return;
    }
    // A Bot nobody has started a channel with still has somewhere to be opened.
    await navigate({ to: "/bot", search: { agent: notification.botId } });
  };

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {showing.map((notification) => (
          <Toast
            key={notification.id}
            botName={nameOf(notification.botId)}
            notification={notification}
            onDismiss={() => dismiss(notification.id)}
            onOpen={() => void open(notification)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function desktopNotificationsWanted(): boolean {
  try {
    return parseDesktopNotificationsPreference(
      window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

function Toast({
  botName,
  notification,
  onDismiss,
  onOpen,
}: {
  botName: string;
  notification: BotNotification;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  /**
   * The card's own countdown, started when it appeared and cancelled only when it goes.
   *
   * Reached through a ref so the effect has nothing to depend on but the mount. `onDismiss` closes
   * over the list's state and is a new function on every render of it, and an effect that listed it
   * would restart the countdown every time any Bot's marker changed anywhere — the slower version of
   * never expiring at all.
   */
  const expire = useRef(onDismiss);
  useEffect(() => {
    expire.current = onDismiss;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => expire.current(), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      className="pointer-events-auto"
      exit={{ opacity: 0 }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(8px)",
      }}
      layout={shouldReduceMotion ? false : "position"}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-3 shadow-lg">
        <span
          aria-hidden
          className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500"
        />
        {/* The whole card opens the Bot; the close button is the only other target inside it. */}
        <button
          className="min-w-0 flex-1 text-left"
          onClick={onOpen}
          type="button"
        >
          <span className="block truncate text-sm tracking-tight">
            {botName} {notification.headline}
          </span>
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
            {notification.detail}
          </span>
        </button>
        <Button
          aria-label="Dismiss"
          className="-mr-1 -mt-1 size-7 shrink-0"
          onClick={onDismiss}
          size="icon"
          variant="ghost"
        >
          <IconX className="size-4" />
        </Button>
      </div>
    </motion.div>
  );
}
