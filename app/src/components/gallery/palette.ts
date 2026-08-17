/**
 * Fixed chart palette. Models do not choose series colours, so a series keeps the same colour across
 * charts and avoids state colours such as refusal red.
 */
export const SERIES_COLOURS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
] as const;

export function seriesColour(index: number): string {
  return SERIES_COLOURS[index % SERIES_COLOURS.length] as string;
}

/**
 * Red and green mean something. Kept out of `SERIES_COLOURS` so a chart cannot accidentally colour
 * an ordinary series in the shade this app uses for a refusal.
 */
export const STATE_COLOURS = {
  positive: "#10b981",
  caution: "#f59e0b",
  negative: "#ef4444",
} as const;
