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
 * The sidebar's width, one for every shell (app, admin, settings) and remembered across reloads, so
 * going from a conversation to Settings never moves the edge of the page. 340px before anybody drags
 * it: the app's roster needs that for its two-line message previews, and the other shells match it.
 *
 * Dragged on the sidebar's edge (`SidebarRail`). Never narrower than what its own footer needs, which
 * the rail measures as the drag starts, nor than `SIDEBAR_MIN_WIDTH`; never wider than
 * `SIDEBAR_MAX_WIDTH`, past which a roster stops being a column beside the work and becomes the work.
 */
export const SIDEBAR_WIDTH = "340px";
export const SIDEBAR_WIDTH_STORAGE_KEY = "openbot-sidebar-width";
/**
 * Where the app's own width was kept when each shell had one. Read when the shared width was never
 * written, so a width somebody dragged before survives; admin's and settings' old widths are not.
 */
export const LEGACY_APP_SIDEBAR_WIDTH_KEY = "openbot-sidebar-width:app";
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

/** The width to start every shell at: the shared one, else the app's old one, else the default. */
export function storedSidebarWidth(
  read: (key: string) => string | null,
): string {
  return parseStoredSidebarWidth(
    read(SIDEBAR_WIDTH_STORAGE_KEY) ?? read(LEGACY_APP_SIDEBAR_WIDTH_KEY),
    SIDEBAR_WIDTH,
  );
}

/**
 * The narrowest a dragged sidebar may be: the panel's own floor (`SIDEBAR_MIN_WIDTH`) plus the
 * strip beside it, or what the footer needs to show whole (`footerNeeds`), whichever is more.
 */
export function sidebarFloor(
  stripWidth: number,
  footerNeeds: number | null,
): number {
  return Math.max(SIDEBAR_MIN_WIDTH + stripWidth, footerNeeds ?? 0);
}

/** A dragged width, held between `min` (at least `SIDEBAR_MIN_WIDTH`) and `SIDEBAR_MAX_WIDTH`. */
export function clampSidebarWidth(pixels: number, min: number): number {
  return Math.round(
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(min, SIDEBAR_MIN_WIDTH, pixels)),
  );
}

/**
 * Whether a page draws its "Show sidebar" button: the way back to a panel that is hidden. Not while
 * the panel is showing, and not on a section with no panel, where the strip beside the page is the
 * way to Conversations. Always in a narrow window, whose sheet starts closed.
 */
export function sidebarToggleShown({
  isMobile,
  open,
  panelAvailable,
}: {
  isMobile: boolean;
  open: boolean;
  panelAvailable: boolean;
}): boolean {
  return isMobile || (!open && panelAvailable);
}

/**
 * The shared width as a sidebar with a strip draws it: never under the panel's floor plus the strip,
 * since Admin and Settings, which have no strip, may be dragged down to the floor alone.
 */
export function widthBesideStrip(width: string): string {
  return `max(${width}, calc(${SIDEBAR_MIN_WIDTH}px + var(--sidebar-width-icon)))`;
}
