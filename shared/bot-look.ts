/**
 * How a Bot looks, as the server checks it and the orb draws it.
 *
 * A Bot's look is its avatar seed. The orb hashes the seed into one of the colours below, and into
 * the few small ways two Bots in one colour still differ. A seed may also name its colour: one that
 * starts with a colour and a colon, as `moss:k2p9x7aq`, is drawn in that colour, and the rest of its
 * look still comes from the hash of the whole seed. Any other seed is drawn as it always was, so a
 * Bot nobody has restyled keeps its face.
 *
 * One declaration read from both sides, so the server never accepts a look the orb draws differently
 * from what was picked, and never refuses one the screen offered.
 */

/**
 * The eight colours a Bot can be, in the order the orb picks from by hash: reordering one changes
 * the colour of most Bots that never chose one. Violet is OpenBot's own mark and is not among them,
 * so a Bot is never mistaken for OpenBot, and a seed that names it is drawn as if it named none.
 */
export const BOT_COLOURS = [
  "ember",
  "moss",
  "sun",
  "berry",
  "ocean",
  "sky",
  "coral",
  "slate",
] as const;

export type BotColour = (typeof BOT_COLOURS)[number];

export function isBotColour(value: string): value is BotColour {
  return (BOT_COLOURS as readonly string[]).includes(value);
}

/** What comes before the first colon of a seed, or null when it has none. */
function prefixOf(seed: string): string | null {
  const at = seed.indexOf(":");
  return at < 0 ? null : seed.slice(0, at);
}

/** The colour a seed names, or null when it names none: no prefix, an unknown one, or violet. */
export function namedColour(seed: string): BotColour | null {
  const prefix = prefixOf(seed);
  return prefix !== null && isBotColour(prefix) ? prefix : null;
}

/** A seed drawn in `colour`, its face drawn from `face`. */
export function seedFor(colour: BotColour, face: string): string {
  return `${colour}:${face}`;
}

/** How a seed may be spelled: short, and safe in a URL, a log line or an attribute. */
const AVATAR_SEED = /^[A-Za-z0-9_:-]{1,64}$/;

/**
 * Why a seed can't be a Bot's look, or null when it can. The server answers a refused look with
 * this sentence.
 */
export function avatarSeedProblem(seed: unknown): string | null {
  if (typeof seed !== "string" || !AVATAR_SEED.test(seed)) {
    return "A Bot's look is 1 to 64 letters, numbers, hyphens, underscores or colons.";
  }
  const prefix = prefixOf(seed);
  if (prefix === null || isBotColour(prefix)) return null;
  if (prefix === "violet") {
    return "Violet is kept for OpenBot. Pick another colour.";
  }
  return "That isn't a colour a Bot can have. Pick one of the eight.";
}

const FACE_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A face nobody has drawn yet: eight random letters and digits. From `getRandomValues`, which a
 * browser offers on a page served over plain HTTP, where `randomUUID` is missing.
 */
export function newFace(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => FACE_LETTERS[byte % 36]).join("");
}

/**
 * `seed` in `colour` instead: the same face, so going back to a colour finds the face it had. A seed
 * whose face can't be kept within the spelling above, as a copy of a Bot with a long or unusual id,
 * gets a new face.
 */
export function recoloured(seed: string, colour: BotColour): string {
  const face =
    namedColour(seed) === null ? seed : seed.slice(seed.indexOf(":") + 1);
  const kept = seedFor(colour, face);
  return avatarSeedProblem(kept) === null ? kept : seedFor(colour, newFace());
}
