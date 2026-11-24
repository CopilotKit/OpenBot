/**
 * The stock buddies the app ships: animated characters a Bot can be drawn as, with no key and nothing
 * to make. Their files are unpacked into app/public/buddies/<id>/ by scripts/fetch-stock-buddies.ts
 * (gitignored, 79 MB), from labs-buddy at the commit below.
 */
export const STOCK_BUDDY_SOURCE = {
  base: "https://source.tanstack.com/@jherr/labs-buddy/raw",
  commit: "15fa48f118b5975ce7bdf802a24bca8c62175651",
  path: "apps/buddy-builder/public/stock",
} as const;

export type StockBuddy = {
  /** The buddy's id, as `stock:<id>` names it in a Bot's buddy. */
  id: string;
  name: string;
  /** The `.buddy` file at labs-buddy. */
  file: string;
};

export const STOCK_BUDDIES: readonly StockBuddy[] = [
  { id: "meemers", name: "Meemers", file: "meemers.buddy" },
  {
    id: "rocky-maestro",
    name: "Rocky Maestro",
    file: "rocky-maestro-9s9d.buddy",
  },
  {
    id: "captain-blaze",
    name: "Captain Blaze",
    file: "captain-blaze-6mef.buddy",
  },
  {
    id: "cogsworth-kaiju",
    name: "Cogsworth Kaiju",
    file: "cogsworth-kaiju-x4k5.buddy",
  },
  { id: "murfrito", name: "Murfrito", file: "murfrito-3c6y.buddy" },
  { id: "nibbles", name: "Nibbles", file: "nibbles-die6.buddy" },
  { id: "nuts-mcgee", name: "Nuts McGee", file: "nuts-mcgee-bsge.buddy" },
  { id: "rusty-fidget", name: "Rusty Fidget", file: "rusty-fidget-v42n.buddy" },
  { id: "shimmer-spin", name: "Shimmer Spin", file: "shimmer-spin-48dk.buddy" },
  { id: "sparkle-snap", name: "Sparkle Snap", file: "sparkle-snap-os9e.buddy" },
  {
    id: "zara-quickfingers",
    name: "Zara Quickfingers",
    file: "zara-quickfingers-h7lk.buddy",
  },
];

/** The poses every stock buddy has a clip for. */
export const STOCK_POSES = [
  "idle",
  "greeting",
  "listening",
  "thinking",
  "thinkingHard",
  "searching",
  "reading",
  "working",
  "writing",
  "typing",
  "talking",
  "asking",
  "done",
  "error",
  "sleeping",
] as const;
