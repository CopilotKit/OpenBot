import { BotOrb } from "@/components/agents/orb/bot-orb";
import { orbPaletteFor } from "@/components/agents/orb/bot-orb-draw";

/**
 * A Bot's face: its orb, in the colour its seed picks, so the same Bot looks the same everywhere.
 * The orb hides itself from assistive tech, so the Bot is announced once, by name.
 *
 * Clipped to its circle, so its glow never spills into the row beside it or makes a list scroll.
 * At rest the glow is too faint that far out to be missed.
 */
export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      <BotOrb palette={orbPaletteFor(seed)} size={size} />
    </span>
  );
}
