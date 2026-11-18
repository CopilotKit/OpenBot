import { createContext, useContext } from "react";

/** How a Bot is drawn: as its orb, as its kite (the Kite Bot skin), or as the generated face. */
export type BotLook = "orb" | "kite" | "face";

/** Whether Bots are drawn as a mark of their own, an orb or a kite, rather than as faces. */
export function drawsBotMark(look: BotLook): boolean {
  return look !== "face";
}

/*
 * Set once, from the active skin's `botLook` (see `_authed.tsx`), so a component asks how to draw a
 * Bot rather than which skin is on. A skin opts in to orbs by setting `botLook: "orb"`, or to kites
 * with `botLook: "kite"`; without a provider, as in a component test, Bots are faces.
 */
const BotLookContext = createContext<BotLook>("face");

export const BotLookProvider = BotLookContext.Provider;

export function useBotLook(): BotLook {
  return useContext(BotLookContext);
}
