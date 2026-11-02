import { cn } from "@/lib/utils";
import { BotOrb, type BotOrbState } from "./bot-orb";

/** What OpenBot is doing, wherever its own mark stands for it. */
export type AIState =
  | "idle"
  | "listening"
  | "thinking"
  | "streaming"
  | "done"
  | "error";

/**
 * Each state as the orb shows it. Streaming is still working. An error rests, and the words beside
 * the mark say what went wrong.
 */
const ORB_STATE: Record<AIState, BotOrbState> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  streaming: "thinking",
  done: "done",
  error: "idle",
};

export interface AgentOrbProps {
  className?: string;
  /**
   * Its footprint, in px, as "64px". Only px: the orb is drawn on a canvas at that size, so a share
   * of its container, as "100%", has nothing to be a share of.
   */
  size?: `${number}px`;
  state?: AIState;
}

/** The size a mark is drawn at when it is given one that isn't in px. */
const FALLBACK_SIZE = 192;
/** The sizes already warned about, so a mark redrawn every frame doesn't flood the console. */
const warned = new Set<string>();

/** Its footprint in px, or the fallback, with one warning, when the size isn't in px. */
function pxOf(size: string): number {
  if (/^\d+(\.\d+)?px$/.test(size)) return Number.parseFloat(size);
  if (!warned.has(size)) {
    warned.add(size);
    console.warn(
      `AgentOrb's size is in px, as "64px", not "${size}". Drawing it at ${FALLBACK_SIZE}px.`,
    );
  }
  return FALLBACK_SIZE;
}

/**
 * OpenBot's own mark: the orb, in OpenBot's violet. A size that slips past the type, from a style
 * or a cast, draws the mark at its default size and warns once, so one slip never takes the screen
 * down with it.
 */
export default function AgentOrb({
  className,
  size = `${FALLBACK_SIZE}px`,
  state = "idle",
}: AgentOrbProps) {
  return (
    <BotOrb
      className={cn("agent-orb block", className)}
      size={pxOf(size)}
      state={ORB_STATE[state]}
    />
  );
}
