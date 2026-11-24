import type { SkinId } from "./types";

/**
 * WHICH UI KIT A SKIN IS DRAWN WITH, the one switch between the two.
 *
 * `current` is the UI Kit of the November 2026 redesign (Figma "OpenBot (MASTER)", page UI Kit):
 * its tokens in theme.css, its primitives in components/ui, and the screens redrawn from the
 * Master screens. `legacy` is what the alternate skins were drawn with before it: the same
 * primitives, set back to their old sizes, corners and type by skins/legacy-base.css.
 *
 * Everything that differs between the two keys on this and never on a skin's id:
 *
 *   - CSS: `<html data-kit="legacy">` (absent for the current kit, so the default look needs no
 *     script). skins/legacy-base.css sets the legacy values under `:root[data-kit="legacy"]`; a rule
 *     for the current kit alone is scoped `:root:not([data-kit="legacy"])` (styles.css).
 *   - Classes: `kit:` for the current kit alone, `legacy:` for the legacy kit alone.
 *   - React: `useKit()` from skins/store.ts, where a screen's structure differs (Bot Cards on Bots).
 *
 * So a skin moves to the current kit by changing its line here and giving its skin.css the current
 * kit's palette and type, with no screen to edit. A skin's own frame and screens are a separate
 * question, its own.
 */
export type Kit = "current" | "legacy";

/** Keyed by every skin, so a skin cannot be registered without saying which kit it is drawn with. */
export const SKIN_KITS: Record<SkinId, Kit> = {
  openbot: "current",
  openduet: "legacy",
  opendots: "legacy",
  openfuse: "legacy",
};

/**
 * The kit as last drawn, beside the skin under `SKIN_STORAGE_KEY`, for `index.html` to mark `<html>`
 * before the first paint without knowing which skins this build ships.
 */
export const KIT_STORAGE_KEY = "openbot-kit";

export function kitOf(id: SkinId): Kit {
  return SKIN_KITS[id];
}
