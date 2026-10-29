import type { CSSProperties } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { orbPalette } from "@/lib/orb-palette";

/** At this size and smaller, an idle orb is drawn still. */
const STATIC_MAX_SIZE = 32;

/*
 * The still orb: the live orb's base sphere (a lit radial in the palette's own stops) with one
 * conic sweep over it for the mesh, and a soft highlight on top. Drawn from the custom properties
 * set on the element, so the fill is written once and the palette is the only thing that varies.
 */
const STATIC_FILL = [
  "radial-gradient(circle at 30% 24%, hsl(0 0% 100% / 0.28), transparent 34%)",
  "conic-gradient(from 200deg at 70% 30%, var(--c1), transparent 30% 65%, var(--c1))",
  "radial-gradient(circle at 38% 34%, var(--c4) 0%, var(--c2) 42%, var(--c3) 100%)",
].join(", ");

/**
 * A Bot drawn as its orb, in the palette its seed picks (`orbPalette`), so renaming a Bot keeps
 * its color.
 *
 * At avatar sizes an idle Bot gets a still orb drawn with CSS alone: twenty animated orbs in a
 * sidebar would each run a blur and a backdrop filter on every frame. A larger orb, or one whose
 * Bot is working, is the live `AgentOrb`. Neither moves under reduced motion: `AgentOrb` honours
 * it, and the still orb has nothing to move.
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
        className="inline-block shrink-0 rounded-full"
        style={
          {
            "--c1": colors.c1,
            "--c2": colors.c2,
            "--c3": colors.c3,
            "--c4": colors.c4,
            background: STATIC_FILL,
            boxShadow: "var(--orb-edge)",
            height: size,
            width: size,
          } as CSSProperties
        }
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={name}
      data-variant="live"
      className="bot-orb-live inline-flex shrink-0 rounded-full"
      style={{ boxShadow: "var(--orb-edge)", height: size, width: size }}
    >
      {/* Hidden so the Bot is announced once, by name. A waiting Bot idles: the next move is the
          person's, not the Bot's. */}
      <span aria-hidden="true" className="contents">
        <AgentOrb
          colors={colors}
          size={`${size}px`}
          state={state === "working" ? "thinking" : "idle"}
        />
      </span>
    </span>
  );
}
