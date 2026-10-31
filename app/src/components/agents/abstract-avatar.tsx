import { BotOrb } from "@/components/agents/orb/bot-orb";

/**
 * A Bot's face: its orb, with the look its seed picks. The seed is the Bot's id unless a tenant
 * package set one or the Bot was copied from another, so `ChannelAvatar`, which goes by id, matches it
 * for every other Bot.
 * The orb hides itself from assistive tech, so the Bot is announced once, by name. Beside a heading
 * that already names the Bot, pass `decorative` and the face is hidden too, so it isn't said twice.
 *
 * Clipped to its circle, so its glow never spills into the row beside it or makes a list scroll.
 * At rest the glow is too faint that far out to be missed.
 */
export function AbstractAvatar({
  decorative = false,
  name,
  seed,
  size = 40,
}: {
  decorative?: boolean;
  name: string;
  seed: string;
  size?: number;
}) {
  return (
    <span
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": name })}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      <BotOrb seed={seed} size={size} />
    </span>
  );
}
