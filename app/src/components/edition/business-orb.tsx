/**
 * OpenBot's orb, large and alive, over an endless field of smaller ones drifting upwards: one
 * OpenBot, and the many a team runs. Drawn in CSS rather than shipped as a picture, so it moves and
 * costs nothing to load. The animations are in styles.css, and hold still under reduced motion.
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
        <div className="business-orb-float relative size-48">
          <div className="business-orb-glow absolute inset-0 rounded-full" />
          <div className="relative size-full overflow-hidden rounded-full shadow-2xl">
            <div className="business-orb-swirl absolute -inset-1/4" />
            <div className="business-orb-shine absolute inset-0" />
          </div>
        </div>
      </div>
    </div>
  );
}

/*
 * One tile of the field: two small orbs, the second offset half a tile both ways, so the field
 * reads as staggered rows rather than a checkerboard. Its height is the distance the field moves in
 * one loop (`--business-orb-tile` in styles.css), which is what makes the loop seamless.
 */
const FIELD_TILE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="144" viewBox="0 0 72 144">
    <defs>
      <linearGradient id="o" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f9a8d4"/>
        <stop offset=".5" stop-color="#c084fc"/>
        <stop offset="1" stop-color="#93c5fd"/>
      </linearGradient>
    </defs>
    <circle cx="18" cy="36" r="14" fill="url(#o)"/>
    <circle cx="54" cy="108" r="14" fill="url(#o)"/>
  </svg>`,
)}`;
