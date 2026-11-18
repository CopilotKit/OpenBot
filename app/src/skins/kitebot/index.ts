import type { Skin } from "../types";
import { KiteBotFrame } from "./frame";
import { KiteSky } from "./sky";

/*
 * Kite Bot over OpenBot. Every Bot is drawn as OpenBot's kite, each in a colour and sail pattern of
 * its own (components/agents/kite), on quiet black-and-white chrome, so the Bots are the colour on
 * the page. The frame lists Bots first, with what waits on you above them; the home page shows the
 * Sky, every Bot's kite and what it is doing. The pages inside are OpenBot's own.
 */
export const kitebot: Skin = {
  id: "kitebot",
  name: "Kite Bot",
  description:
    "Your Bots as kites in their own colours, listed first, with what needs you on top.",
  Frame: KiteBotFrame,
  botLook: "kite",
  home: KiteSky,
};
