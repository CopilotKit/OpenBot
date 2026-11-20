import { ORB_IMAGES } from "@/components/agents/orb-images";
import { ORB_PALETTES, orbPalette } from "@/lib/orb-palette";

/**
 * A Bot drawn as its orb: the designers' picture for the palette its seed picks (`orbPalette`), so
 * renaming a Bot keeps its color. Only OpenBot's own look draws Bots as orbs; the skins draw faces
 * (`BotLookProvider`).
 *
 * ONE PICTURE AT EVERY SIZE. Figma's "Orbs" are eight finished spheres, glow and rim included
 * (`ORB_IMAGES`), so a Bot is the same sphere in the sidebar, on its page and at the top of a
 * conversation, and nothing is blurred or animated per frame to draw it.
 *
 * A working Bot's orb breathes (`.bot-orb-image` in styles.css): it eases a little smaller and
 * brighter and back, so the sidebar shows which Bots are busy. Under reduced motion it holds still.
 * A waiting Bot is still: the next move is the person's.
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
  const image =
    ORB_IMAGES[ORB_PALETTES.indexOf(orbPalette(seed))] ?? ORB_IMAGES[0];
  return (
    <span
      role="img"
      aria-label={name}
      data-variant="image"
      data-state={state}
      className="bot-orb-image inline-block shrink-0 rounded-full"
      style={{
        backgroundImage: `url("${image}")`,
        height: size,
        width: size,
      }}
    />
  );
}
