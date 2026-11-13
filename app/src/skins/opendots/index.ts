import type { Skin } from "../types";
import { OpenDotsFrame } from "./frame";
import { MemoriesScreen, RoutinesScreen } from "./screens";

/*
 * OpenDots over OpenBot. The frame is OpenDots' rail, Dots sidebar, top bar and computer pane; the
 * pages inside it are OpenBot's, chat included, in OpenDots' colours. Its top bar's
 * pause-everything switch is OpenBot's pause all. Left out because OpenBot has nothing behind them:
 * Spaces and their pages, page chats and the Brief.
 */
export const opendots: Skin = {
  id: "opendots",
  name: "OpenDots",
  description:
    "A compact sidebar of your Bots, with each Bot's computer beside the conversation.",
  Frame: OpenDotsFrame,
  screens: {
    routines: RoutinesScreen,
    memories: MemoriesScreen,
  },
};
