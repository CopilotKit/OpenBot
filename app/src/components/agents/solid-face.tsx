/*
 * A Bot drawn as a solid coloured circle with two small eye marks, the faces Jack's Pocket app
 * uses. The colour is picked from the Bot's seed, so the same Bot keeps the same colour everywhere.
 */
export const SOLID_FACE_COLORS = [
  "#8b9cff",
  "#4fc4b0",
  "#f0a64a",
  "#9a7cf4",
  "#4f8ff0",
  "#e8875a",
  "#d58ae8",
  "#6fcf7a",
] as const;

export function solidFaceColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return SOLID_FACE_COLORS[hash % SOLID_FACE_COLORS.length];
}

export function SolidFace({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  return (
    <svg
      aria-label={name}
      className="shrink-0"
      height={size}
      role="img"
      viewBox="0 0 100 100"
      width={size}
    >
      <circle cx="50" cy="50" fill={solidFaceColor(seed)} r="50" />
      <rect
        fill="#141816"
        height="22"
        rx="5"
        transform="rotate(-12 48 41)"
        width="12"
        x="42"
        y="30"
      />
      <rect
        fill="#141816"
        height="22"
        rx="5"
        transform="rotate(-12 66 37)"
        width="12"
        x="60"
        y="26"
      />
    </svg>
  );
}
