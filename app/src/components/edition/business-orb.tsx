import AgentOrb from "@/components/agents/orb/agent-orb";
import { ORB_PALETTES } from "@/lib/orb-palette";

/** The big orb's palette: periwinkle, the nearest of the eight to OpenBot's own mark. */
const ORB_COLORS = ORB_PALETTES[2];

/**
 * A Bot's live orb, the one at the top of a conversation, over an endless field of smaller orbs in
 * every Bot colour drifting upwards: one OpenBot, and the many a team runs. The field is CSS, so it
 * costs nothing to load; its animation is in styles.css. Both hold still under reduced motion.
 */
export function BusinessOrb() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="business-illustration"
    >
      <div
        className="business-orb-field absolute inset-0"
        style={{ backgroundImage: `url("${FIELD_TILE}")` }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        {/* `.bot-orb-live` gives it the same finish as a Bot's orb in a conversation. */}
        <span className="bot-orb-live inline-flex rounded-full ring-1 ring-foreground/10">
          <AgentOrb colors={ORB_COLORS} size="176px" />
        </span>
      </div>
    </div>
  );
}

/*
 * One tile of the field: four staggered rows of four orbs, every Bot palette twice and shuffled so
 * no column repeats a colour, lit the way the still `BotOrb` is (`c4` through `c2` to `c3`). The
 * shifted rows' first orb sits on the tile's edge, so it is drawn at both edges and the repeat
 * completes it. The tile's height is the distance the field moves in one loop
 * (`--business-orb-tile` in styles.css), which is what makes it seamless.
 */
const FIELD_ORBS: readonly [x: number, y: number, palette: number][] = [
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

const FIELD_TILE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288"><defs>${ORB_PALETTES.map(
    (colors, index) =>
      `<radialGradient id="p${index}" cx=".38" cy=".34" r=".7"><stop offset="0" stop-color="${colors.c4}"/><stop offset=".42" stop-color="${colors.c2}"/><stop offset="1" stop-color="${colors.c3}"/></radialGradient>`,
  ).join("")}</defs>${FIELD_ORBS.map(
    ([x, y, palette]) =>
      `<circle cx="${x}" cy="${y}" r="14" fill="url(#p${palette})"/>`,
  ).join("")}</svg>`,
)}`;
