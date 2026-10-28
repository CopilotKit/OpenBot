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
  /** Its footprint, in px, as "64px". */
  size?: string;
  state?: AIState;
}

/** OpenBot's own mark: the orb, in OpenBot's violet. */
export default function AgentOrb({
  className,
  size = "192px",
  state = "idle",
}: AgentOrbProps) {
  return (
    <BotOrb
      className={cn("agent-orb block", className)}
      palette="violet"
      size={Number.parseFloat(size)}
      state={ORB_STATE[state]}
    />
  );
}
