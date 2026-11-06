import { BotKite, OpenBotKite } from "@/components/agents/kite/kite";
import type { KiteState } from "@/components/agents/kite/kite-draw";

/**
 * A kite in one of onboarding's pictures: a Bot's, in the livery its seed picks as `BotKite` draws
 * it, or OpenBot's own with no seed. Decorative: the picture around it is labelled, so the kite has
 * no name of its own. `still` holds it while its picture is off screen.
 */
export function DemoKite({
  seed,
  size,
  state = "idle",
  still = false,
}: {
  seed?: string;
  size: number;
  state?: KiteState;
  still?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0"
      data-kite-demo={seed ? "bot" : "openbot"}
      data-state={state}
    >
      {seed ? (
        <BotKite name="" seed={seed} size={size} state={state} still={still} />
      ) : (
        <OpenBotKite size={size} state={state} still={still} />
      )}
    </span>
  );
}
