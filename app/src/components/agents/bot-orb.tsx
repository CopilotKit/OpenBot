import type { CSSProperties } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { orbPalette } from "@/lib/orb-palette";

/** At this size and smaller, an idle orb is drawn still. */
const STATIC_MAX_SIZE = 32;

/**
 * A Bot drawn as its orb, in the palette its seed picks (`orbPalette`), so renaming a Bot keeps
 * its color.
 *
 * One sphere at every size (`.bot-orb-still` and `.bot-orb-live` in styles.css), so a Bot is the
 * same color in the sidebar, at the top of its page and at the top of a conversation. At avatar
 * sizes an idle Bot's sphere is drawn still, with CSS alone: twenty animated orbs in a sidebar would
 * each run a blur and a backdrop filter on every frame. A larger orb, or one whose Bot is working,
 * is the live `AgentOrb` drawing the same sphere, in the palette as it is in every state. Neither
 * moves under reduced motion: `AgentOrb` honours it, and the still orb has nothing to move.
 */
export function BotOrb({
  seed,
  name,
  size = 32,
  state = "idle",
}: {
  seed: string;
  name: string;
  size?: number;
  state?: "idle" | "working" | "waiting";
}) {
  const colors = orbPalette(seed);

  if (size <= STATIC_MAX_SIZE && state === "idle") {
    return (
      <span
        role="img"
        aria-label={name}
        data-variant="static"
        className="bot-orb-still inline-block shrink-0 rounded-full ring-1 ring-foreground/10"
        style={
          {
            "--c1": colors.c1,
            "--c2": colors.c2,
            "--c3": colors.c3,
            "--c4": colors.c4,
            height: size,
            width: size,
          } as CSSProperties
        }
      />
    );
  }

  // No outline, unlike the still orb: the live disc idles at 94% of this box, so a ring here floats
  // off its edge, and on the dark page it read as a light ring around the orb. The disc has its rim.
  return (
    <span
      role="img"
      aria-label={name}
      data-variant="live"
      className="bot-orb-live inline-flex shrink-0 rounded-full"
      style={{ height: size, width: size }}
    >
      {/* Hidden so the Bot is announced once, by name. A waiting Bot idles: the next move is the
          person's, not the Bot's. */}
      <span aria-hidden="true" className="contents">
        <AgentOrb
          colors={colors}
          size={`${size}px`}
          state={state === "working" ? "thinking" : "idle"}
          trueColors
        />
      </span>
    </span>
  );
}
