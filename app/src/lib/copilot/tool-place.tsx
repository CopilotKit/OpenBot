import { createContext, useContext } from "react";
import type { CardPlace } from "./carry-on";

/**
 * WHERE A TOOL CALL SITS IN ITS CONVERSATION, for the component a Bot's tool call draws.
 *
 * A tool's renderer is handed the call and its result, and nothing about what came after it. Most need nothing more;
 * a card that has to notice the turn ended on it does. The transcript knows, and provides it around every call it
 * draws.
 */
export type ToolPlace = CardPlace & {
  /** The Bot said something after this call, in the turn it belongs to. */
  spokeAfter: boolean;
};

export const ToolPlaceContext = createContext<ToolPlace | undefined>(undefined);

/** Where the tool call being drawn sits, or undefined outside a transcript. */
export function useToolPlace(): ToolPlace | undefined {
  return useContext(ToolPlaceContext);
}
