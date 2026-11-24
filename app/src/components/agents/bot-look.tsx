import { createContext, useContext } from "react";

/**
 * How a Bot is drawn: as its orb, as its buddy (an animated character, see `bot-buddy.tsx`), or as
 * the generated face. A buddy sits where an orb would, so whatever lays out orbs lays out buddies.
 */
export type BotLook = "orb" | "buddy" | "face";

/*
 * Set once, from the active skin's `botLook` (see `_authed.tsx`), so a component asks how to draw a
 * Bot rather than which skin is on. A skin opts in to orbs or buddies by setting `botLook`; without a
 * provider, as in a component test, Bots are faces.
 */
const BotLookContext = createContext<BotLook>("face");

export const BotLookProvider = BotLookContext.Provider;

export function useBotLook(): BotLook {
  return useContext(BotLookContext);
}
