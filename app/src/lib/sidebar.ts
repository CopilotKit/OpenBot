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
 * Dragged on the sidebar's edge (`SidebarRail`). Never narrower than `SIDEBAR_MIN_WIDTH` (plus the
 * strip beside one); never wider than `SIDEBAR_MAX_WIDTH`, past which a roster stops being a column
 * beside the work and becomes the work, nor than `SIDEBAR_MAX_SHARE` of the window.
 */
export const SIDEBAR_WIDTH = "340px";
export const SIDEBAR_WIDTH_STORAGE_KEY = "openbot-sidebar-width";
/**
 * Where the app's own width was kept when each shell had one. Read when the shared width was never
 * written, so a width somebody dragged before survives; admin's and settings' old widths are not.
 */
export const LEGACY_APP_SIDEBAR_WIDTH_KEY = "openbot-sidebar-width:app";
/**
 * The narrowest a panel may be dragged: room for its heading whole ("Conversations" beside the New
 * conversation button, every group's name in Admin and Settings), and for an icon and the first
 * words of a name, each row cut short with an ellipsis. Low on purpose. "It stops way too wide":
 * the floor was 220px, and once a footer was measured into it, wider still, which on a large screen
 * left a column of empty space a person could not take back, and zoomed in to read, half the
 * window. Not lower: at 160px the panel's own heading read "Conversat…". How narrow is the person's
 * call; the floor only keeps the panel from closing up altogether (hiding it is a click).
 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
/**
 * The most of the window the sidebar takes, whatever width was dragged or remembered. Every width
 * here is in the page's pixels, and zooming in (OpenBot Desktop's View menu, a browser's zoom) makes
 * the window fewer of them wide while the sidebar keeps its count: a 480px sidebar is a third of a
 * 1440px window and, zoomed to 175%, well over half of the 820px it becomes. So the sidebar is held
 * to a share of the window as well, and the remembered width comes back whole once the window is
 * wide enough again. Never under the floor, which wins in a window too narrow for both.
 */
export const SIDEBAR_MAX_SHARE = 0.4;

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
 * strip beside it. Never what its content would like: a floor measured from a footer's widest
 * button is how the sidebar stopped too wide to be dragged any narrower.
 */
export function sidebarFloor(stripWidth: number): number {
  return SIDEBAR_MIN_WIDTH + stripWidth;
}

/**
 * The widest a sidebar may be dragged in a window `windowWidth` wide: `SIDEBAR_MAX_WIDTH`, or
 * `SIDEBAR_MAX_SHARE` of the window where that is less, and never under `floor`.
 */
export function sidebarCeiling(windowWidth: number, floor: number): number {
  return Math.max(
    floor,
    Math.min(SIDEBAR_MAX_WIDTH, Math.floor(windowWidth * SIDEBAR_MAX_SHARE)),
  );
}

/**
 * A dragged width, held between `min` (at least `SIDEBAR_MIN_WIDTH`) and `max` (at most
 * `SIDEBAR_MAX_WIDTH`, and never under `min`).
 */
export function clampSidebarWidth(
  pixels: number,
  min: number,
  max: number = SIDEBAR_MAX_WIDTH,
): number {
  const lowest = Math.max(min, SIDEBAR_MIN_WIDTH);
  const highest = Math.max(lowest, Math.min(max, SIDEBAR_MAX_WIDTH));
  return Math.round(Math.min(highest, Math.max(lowest, pixels)));
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
 * The shared width as a shell draws it (`--sidebar-width`): no more than `SIDEBAR_MAX_SHARE` of the
 * window, and never under the panel's floor, plus the strip beside a strip, since Admin and
 * Settings, which have no strip, may be dragged down to the floor alone. In CSS, so it follows the
 * window as it is resized or zoomed without anybody dragging, and the remembered width is untouched.
 */
export function sidebarWidthStyle(
  width: string,
  { besideStrip }: { besideStrip: boolean },
): string {
  const floor = besideStrip
    ? `calc(${SIDEBAR_MIN_WIDTH}px + var(--sidebar-width-icon))`
    : `${SIDEBAR_MIN_WIDTH}px`;
  return `clamp(${floor}, ${width}, ${SIDEBAR_MAX_SHARE * 100}vw)`;
}
