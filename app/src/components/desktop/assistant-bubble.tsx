import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  AnimatePresence,
  motion,
  useAnimate,
  useReducedMotion,
} from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BotBuddy } from "@/components/agents/bot-buddy";
import { useBotLook } from "@/components/agents/bot-look";
import AgentOrb from "@/components/agents/orb/agent-orb";
import type { AIState } from "@/components/agents/orb/ai-core";
import { hasUnseenActivity } from "@/components/app-sidebar/conversations-panel";
import { useWaitingCount } from "@/components/bot-profile/attention";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { BuddyActivity } from "@/lib/buddies/buddy";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { dragWindow } from "@/lib/desktop/assistant";
import { cn } from "@/lib/utils";

/**
 * The orb, in points. Compact view's window is twice its size (`BUBBLE` in
 * desktop/src-tauri/src/assistant.rs), for its glow, its rings and the room it grows into under the
 * pointer.
 */
const ORB = 60;

/** How far a press on the bubble moves, in pixels, before it drags the bubble instead of opening it. */
const DRAG_SLOP = 4;

/** How long the orb says that the Bots have finished, in milliseconds. */
const DONE_FOR_MS = 2500;

/** An arc going round the orb while a Bot works, in the colour a conversation's row says Working in. */
const WORKING_ARC =
  "conic-gradient(from 0turn, transparent 0turn, rgb(129 140 248 / 0) 0.08turn, rgb(129 140 248) 0.5turn, transparent 0.5turn)";

/** Cuts a filled circle down to its outer 3 pixels, so a gradient behind it reads as a ring. */
const RING_MASK =
  "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))";

/** What the bubble shows, read from the person's conversations and what waits on them. */
export type BubbleSignal = {
  /** A Bot is at work in at least one conversation. */
  working: boolean;
  /** Conversations with a Bot's message the person hasn't had on screen. */
  unread: number;
  /** Things that wait on the person: an approval, a question. */
  waiting: number;
};

/**
 * What happened between two readings: a Bot said something new, or the last Bot at work finished.
 * Nothing happened before the first reading, so the bubble never celebrates what was already there.
 */
export function bubbleEvents(
  previous: BubbleSignal | undefined,
  next: BubbleSignal,
): { replied: boolean; finished: boolean } {
  if (!previous) return { replied: false, finished: false };
  return {
    replied: next.unread > previous.unread,
    finished: previous.working && !next.working,
  };
}

/** What the bubble opens and what is happening, for a screen reader and the pointer's tooltip. */
export function bubbleLabel(signal: BubbleSignal): string {
  const said = ["Open conversations"];
  if (signal.waiting > 0)
    said.push(
      `${signal.waiting} ${signal.waiting === 1 ? "thing needs" : "things need"} you`,
    );
  if (signal.unread > 0)
    said.push(
      `${signal.unread} new ${signal.unread === 1 ? "reply" : "replies"}`,
    );
  if (signal.working) said.push("a Bot is working");
  return said.join(", ");
}

function atWork(channel: ChannelSummary): boolean {
  return (channel.busy ?? false) || (channel.work?.length ?? 0) > 0;
}

/** Undefined until the conversations have loaded, so their arrival is not news. */
function useBubbleSignal(): BubbleSignal | undefined {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const waiting = useWaitingCount();
  const rows = channels.data;
  return useMemo(
    () =>
      rows === undefined
        ? undefined
        : {
            working: rows.some(atWork),
            unread: rows.filter(hasUnseenActivity).length,
            waiting,
          },
    [rows, waiting],
  );
}

/**
 * The Bot the bubble is drawn as where Bots are buddies: the one at work in the first conversation
 * that has one at work, or else the Bot of the person's latest conversation.
 */
function useBubbleBot(): { name: string; seed: string } | undefined {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const rows = channels.data;
  const botId =
    rows?.find(atWork)?.agentIds[0] ??
    rows?.find((row) => row.agentIds.length > 0)?.agentIds[0];
  const { data: bot } = useQuery({
    ...agentListQueryOptions(),
    select: (bots) => bots.find((candidate) => candidate.id === botId),
  });
  return bot ? { name: bot.name, seed: bot.avatarSeed } : undefined;
}

/** How long a new reply has the buddy talking, in milliseconds. */
const TALKING_FOR_MS = 2500;

/** A count that goes up with each new reply, and whether the Bots have just finished. */
function useBubbleEvents(signal: BubbleSignal | undefined): {
  replies: number;
  done: boolean;
} {
  const previous = useRef<BubbleSignal | undefined>(undefined);
  const [replies, setReplies] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!signal) return;
    const happened = bubbleEvents(previous.current, signal);
    previous.current = signal;
    if (happened.replied) setReplies((count) => count + 1);
    if (happened.finished) setDone(true);
  }, [signal]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), DONE_FOR_MS);
    return () => clearTimeout(timer);
  }, [done]);
  return { replies, done };
}

/**
 * Compact view's bubble: OpenBot's orb alone in its window. A click opens the panel; a press that
 * moves drags the window, by the system's own drag, from where the press began.
 *
 * Always a plain circle: the orb sits inside a solid disc that clips it, in its own colours in every
 * state, so its glow never reaches the window's square edge and nothing turns see-through. It says
 * what is happening in the person's conversations without being opened: it grows a little under
 * the pointer, an arc goes round it while a Bot works, a reply sends a ripple out and bounces it, a
 * green ring shows for a moment when the Bots have finished, and an amber ring and a count say
 * something waits on the person. Reduced motion keeps the colours and the counts.
 */
export function AssistantBubble({
  hidden,
  onOpen,
}: {
  hidden: boolean;
  onOpen: () => void;
}) {
  const signal = useBubbleSignal();
  const { replies, done } = useBubbleEvents(signal);
  const reduceMotion = useReducedMotion() ?? false;
  const [bounce, animate] = useAnimate<HTMLDivElement>();
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (replies === 0 || reduceMotion || !bounce.current) return;
    void animate(
      bounce.current,
      { scale: [1, 1.12, 0.97, 1] },
      { duration: 0.7, ease: "easeOut" },
    );
  }, [replies, reduceMotion, animate, bounce]);

  const now = signal ?? { working: false, unread: 0, waiting: 0 };
  const buddies = useBotLook() === "buddy";
  const bubbleBot = useBubbleBot();
  const [talking, setTalking] = useState(false);
  useEffect(() => {
    if (replies === 0) return;
    setTalking(true);
    const timer = setTimeout(() => setTalking(false), TALKING_FOR_MS);
    return () => clearTimeout(timer);
  }, [replies]);
  // What the buddy plays: what waits on the person first, then work, then what just happened.
  const activity: BuddyActivity =
    now.waiting > 0
      ? "waiting"
      : now.working
        ? "working"
        : done
          ? "done"
          : talking
            ? "talking"
            : "idle";
  // How the orb moves. Its colours stay its own (`trueColors`), whatever it is doing.
  const state: AIState = now.working ? "thinking" : done ? "done" : "idle";
  const count = now.waiting > 0 ? now.waiting : now.unread;
  const label = bubbleLabel(now);
  // Nothing moves while the panel is open over it.
  const moving = !hidden && !reduceMotion;

  return (
    // The `hidden` attribute, which Tailwind's preflight keeps hidden over `grid`, and which keeps the
    // folded one from a screen reader too.
    <div className="fixed inset-0 grid place-items-center" hidden={hidden}>
      <motion.button
        aria-label={label}
        className="group relative grid cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          // Enter or Space: a click with no pointer behind it. A pointer's click opens on release.
          if (event.detail === 0) onOpen();
        }}
        onPointerCancel={() => {
          press.current = null;
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          press.current = {
            x: event.screenX,
            y: event.screenY,
            dragging: false,
          };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (!start || start.dragging || (event.buttons & 1) === 0) return;
          const moved = Math.hypot(
            event.screenX - start.x,
            event.screenY - start.y,
          );
          if (moved < DRAG_SLOP) return;
          start.dragging = true;
          dragWindow();
        }}
        onPointerUp={() => {
          const start = press.current;
          press.current = null;
          if (start && !start.dragging) onOpen();
        }}
        style={{ height: ORB, width: ORB }}
        title={label}
        transition={{ type: "spring", stiffness: 420, damping: 24 }}
        type="button"
        whileHover={reduceMotion ? undefined : { scale: 1.06 }}
      >
        {now.waiting > 0 ? (
          <motion.span
            animate={moving ? { opacity: [1, 0.4, 1] } : undefined}
            aria-hidden
            className="pointer-events-none absolute -inset-1.5 rounded-full border-2 border-amber-400"
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : null}
        {now.working ? (
          <motion.span
            animate={moving ? { rotate: 360 } : undefined}
            aria-hidden
            className="pointer-events-none absolute -inset-1.5 rounded-full"
            style={{
              background: WORKING_ARC,
              mask: RING_MASK,
              WebkitMask: RING_MASK,
            }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
          />
        ) : null}
        <AnimatePresence>
          {done && !now.working ? (
            <motion.span
              animate={{ opacity: 1 }}
              aria-hidden
              className="pointer-events-none absolute -inset-1.5 rounded-full border-2 border-emerald-400"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {replies > 0 && moving ? (
            <motion.span
              animate={{ scale: 1.5, opacity: 0 }}
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full border-2 border-primary"
              exit={{ opacity: 0 }}
              initial={{ scale: 1, opacity: 0.8 }}
              key={replies}
              transition={{ duration: 1.1, ease: "easeOut" }}
            />
          ) : null}
        </AnimatePresence>
        {/* The disc's shadow and edge, outside the clip so they show. */}
        <div
          className="relative size-full rounded-full shadow-md ring-1 ring-black/10 transition-shadow duration-200 group-hover:shadow-lg dark:ring-white/15"
          ref={bounce}
        >
          {/*
           * The disc: solid behind the orb, and the circle its glow is cut to. A clip path, because
           * WebKit lets a transformed or blurred child out of a rounded `overflow: hidden`.
           */}
          <div className="grid size-full place-items-center rounded-full bg-background [clip-path:circle(50%)]">
            {buddies && bubbleBot ? (
              <BotBuddy
                activity={activity}
                still={hidden}
                name={bubbleBot.name}
                seed={bubbleBot.seed}
                size={ORB}
              />
            ) : (
              <AgentOrb
                size={`${ORB}px`}
                state={state}
                still={hidden}
                trueColors
              />
            )}
          </div>
        </div>
        {count > 0 ? (
          <motion.span
            animate={{ scale: 1 }}
            aria-hidden
            className={cn(
              "absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full border-2 border-background px-1 font-semibold text-[11px] leading-none tabular-nums",
              now.waiting > 0
                ? "bg-amber-400 text-amber-950"
                : "bg-primary text-primary-foreground",
            )}
            initial={reduceMotion ? false : { scale: 0.4 }}
            key={count}
            transition={{ type: "spring", stiffness: 500, damping: 18 }}
          >
            {count > 9 ? "9+" : count}
          </motion.span>
        ) : null}
      </motion.button>
    </div>
  );
}
