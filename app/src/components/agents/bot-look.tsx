import { createContext, useContext } from "react";

/** How a Bot is drawn: as its orb, or as the generated face. */
export type BotLook = "orb" | "face";

/*
 * Set once, from the active skin's `botLook` (see `_authed.tsx`), so a component asks how to draw a
 * Bot rather than which skin is on. A skin opts in to orbs by setting `botLook: "orb"`; without a
 * provider, as in a component test, Bots are faces.
 */
const BotLookContext = createContext<BotLook>("face");

export const BotLookProvider = BotLookContext.Provider;

export function useBotLook(): BotLook {
  return useContext(BotLookContext);
}
