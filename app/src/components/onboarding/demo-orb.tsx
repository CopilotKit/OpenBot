import type { AIState } from "@/components/agents/orb/ai-core";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { orbPalette } from "@/lib/orb-palette";

/**
 * An orb in one of onboarding's pictures: a Bot's, in the palette its seed picks as `BotOrb` draws
 * it, or OpenBot's own mark with no seed.
 *
 * Always the live `AgentOrb`, because a picture shows a Bot listening, working and done, where
 * `BotOrb` only draws idle, working and waiting. Decorative: the picture around it is labelled, so
 * the orb has no name of its own. `still` holds it while its picture is off screen.
 */
export function DemoOrb({
  seed,
  size,
  state = "idle",
  still = false,
}: {
  seed?: string;
  size: number;
  state?: AIState;
  still?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-orb={seed ? "bot" : "openbot"}
      data-state={state}
      className={`inline-flex shrink-0 rounded-full ${seed ? "bot-orb-live ring-1 ring-foreground/10" : ""}`}
      style={{ height: size, width: size }}
    >
      <AgentOrb
        colors={seed ? orbPalette(seed) : undefined}
        size={`${size}px`}
        state={state}
        still={still}
      />
    </span>
  );
}
