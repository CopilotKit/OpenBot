import type { CSSProperties } from "react";
import { OpenBotKite } from "@/components/agents/kite/kite";
import { KITE_COLORS } from "@/components/agents/kite/kite-draw";

/**
 * OpenBot's own kite over an endless field of smaller kites in every Bot colour drifting upwards:
 * one OpenBot, and the many a team runs. The field is CSS, so it costs nothing to load; its
 * animation is in styles.css. Both hold still under reduced motion.
 */
export function BusinessKite() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="business-illustration"
    >
      <div
        className="business-kite-field absolute inset-0"
        style={
          {
            "--business-kite-light": `url("${TILE.light}")`,
            "--business-kite-dark": `url("${TILE.dark}")`,
          } as CSSProperties
        }
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <OpenBotKite size={176} />
      </div>
    </div>
  );
}

/*
 * One tile of the field: four staggered rows of small kites, every Bot colour twice and shuffled so
 * no column repeats a colour. The shifted rows' first kite sits on the tile's edge, so it is drawn
 * at both edges and the repeat completes it. The tile's height is the distance the field moves in
 * one loop (`--business-kite-tile` in styles.css), which is what makes it seamless.
 */
const FIELD_KITES: readonly [x: number, y: number, slot: number][] = [
  [36, 36, 0],
  [108, 36, 4],
  [180, 36, 1],
  [252, 36, 5],
  [0, 108, 2],
  [72, 108, 6],
  [144, 108, 3],
  [216, 108, 7],
  [288, 108, 2],
  [36, 180, 5],
  [108, 180, 3],
  [180, 180, 7],
  [252, 180, 0],
  [0, 252, 4],
  [72, 252, 1],
  [144, 252, 6],
  [216, 252, 2],
  [288, 252, 4],
];

/** The kite's outline in a 32 px slot centred on (x, y), as `kite-draw.ts` builds it. */
function kitePoints(x: number, y: number): string {
  const S = 32;
  return [
    [x, y - 0.45 * S],
    [x + 0.45 * S, y - 0.09 * S],
    [x, y + 0.45 * S],
    [x - 0.45 * S, y - 0.09 * S],
  ]
    .map(([px, py]) => `${px},${py}`)
    .join(" ");
}

function fieldTile(dark: boolean): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288">${FIELD_KITES.map(
      ([x, y, slot]) =>
        `<polygon points="${kitePoints(x, y)}" fill="${dark ? KITE_COLORS[slot].darkHex : KITE_COLORS[slot].hex}"/>`,
    ).join("")}</svg>`,
  )}`;
}

const TILE = { light: fieldTile(false), dark: fieldTile(true) };
