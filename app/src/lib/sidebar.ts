/**
 * Whether the shell's sidebar is open, remembered across reloads.
 *
 * The primitive under `components/ui/sidebar.tsx` writes a `sidebar_state` cookie of its own, which
 * exists so a server-rendered shell can paint the right width on the first byte. Nothing renders
 * this app on a server, and nothing ever read that cookie back — so the preference lives here
 * instead, in the same shape and the same storage as the theme preference next door.
 */
export const SIDEBAR_STORAGE_KEY = "openbot-sidebar";

/**
 * Only the exact stored `collapsed` starts the sidebar closed.
 *
 * Everything else opens it: a key never written, a value from an older build, a value somebody
 * else's script left behind. The roster is this app's navigation, and the cost of the two mistakes
 * is not symmetric — opening a sidebar somebody wanted shut costs them one click, while shutting one
 * on a guess hides every channel they have behind an affordance they have not found yet.
 */
export function parseStoredSidebarOpen(value: string | null) {
  return value !== "collapsed";
}

type SidebarEffects = {
  setStoredValue: (key: string, value: string) => void;
};

/**
 * Records the state in the vocabulary the primitive already uses for it — `expanded` and
 * `collapsed`, the two values of its `data-state` attribute — rather than inventing a second pair.
 */
export function applySidebarOpen(open: boolean, effects: SidebarEffects) {
  effects.setStoredValue(SIDEBAR_STORAGE_KEY, open ? "expanded" : "collapsed");
}

/**
 * Each shell's sidebar width, remembered across reloads, under this prefix and the shell's name.
 *
 * Dragged on the sidebar's edge (`SidebarRail`). Never narrower than what its own footer needs, which
 * the rail measures as the drag starts, nor than `SIDEBAR_MIN_WIDTH`; never wider than
 * `SIDEBAR_MAX_WIDTH`, past which a roster stops being a column beside the work and becomes the work.
 */
export const SIDEBAR_WIDTH_STORAGE_PREFIX = "openbot-sidebar-width:";
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;

/** A stored width in pixels, or `fallback` for anything that is not one within bounds. */
export function parseStoredSidebarWidth(
  value: string | null,
  fallback: string,
): string {
  const pixels = Number(value);
  return value !== null &&
    Number.isFinite(pixels) &&
    pixels >= SIDEBAR_MIN_WIDTH &&
    pixels <= SIDEBAR_MAX_WIDTH
    ? `${pixels}px`
    : fallback;
}

/** A dragged width, held between `min` (at least `SIDEBAR_MIN_WIDTH`) and `SIDEBAR_MAX_WIDTH`. */
export function clampSidebarWidth(pixels: number, min: number): number {
  return Math.round(
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(min, SIDEBAR_MIN_WIDTH, pixels)),
  );
}
