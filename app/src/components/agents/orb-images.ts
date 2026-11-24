import lilac from "@/assets/orbs/lilac.webp";
import mint from "@/assets/orbs/mint.webp";
import orange from "@/assets/orbs/orange.webp";
import periwinkle from "@/assets/orbs/periwinkle.webp";
import red from "@/assets/orbs/red.webp";
import sky from "@/assets/orbs/sky.webp";
import teal from "@/assets/orbs/teal.webp";
import violet from "@/assets/orbs/violet.webp";

/**
 * A Bot's orb in OpenBot's own look: Figma's "Orbs" (Master file, 6787:29283), the designers' eight
 * Bot Avatars, one for each palette in `ORB_PALETTES` and in its order (mint, violet, periwinkle,
 * sky, orange, red, lilac, teal), so a Bot keeps the color its seed gave it.
 *
 * Each is the 256px Bot Avatar and its glow (the light rim and the colored light at its lower
 * right) flattened into one 192px WebP, which covers the largest orb a screen draws (72px) at 2x.
 */
export const ORB_IMAGES: readonly string[] = [
  mint,
  violet,
  periwinkle,
  sky,
  orange,
  red,
  lilac,
  teal,
];
