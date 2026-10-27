import type { Skin } from "../types";
import { OpenDotsFrame } from "./frame";
import { ActivityScreen, MemoriesScreen } from "./screens";

/*
 * OpenDots over OpenBot. The frame is OpenDots' rail, Dots sidebar, top bar and computer pane; the
 * pages inside it are OpenBot's, chat included, in OpenDots' colours. Left out because OpenBot has
 * nothing behind them: Spaces and their pages, page chats, the Brief, and the pause-everything
 * switch (OpenBot pauses one Bot at a time, which the top bar offers for the Bot on screen).
 */
export const opendots: Skin = {
  id: "opendots",
  name: "OpenDots",
  description: "Always-on coworkers, each with its own computer.",
  Frame: OpenDotsFrame,
  screens: {
    activity: ActivityScreen,
    memories: MemoriesScreen,
  },
};
