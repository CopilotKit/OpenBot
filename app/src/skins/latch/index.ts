import type { Skin } from "../types";
import { LatchFrame } from "./frame";
import { LatchHomeBelow, LatchHomeTop } from "./home";

/**
 * Latch's look, taken from Jack's Latch browser: small text, every group on a rounded card with a
 * tiny all-caps label above it, one row style (icon, name, grey line under it, then an arrow or a
 * switch), calm greys and one accent colour. On a computer it keeps OpenBot's own sidebar; on a
 * phone it is laid out like Latch's own phone screens: its home (shortcuts, recents, a status
 * card), its three-icon bottom bar, and its menu and quick tools sliding up from the bottom. Every screen is OpenBot's own, so nothing
 * OpenBot does goes missing.
 */
export const latch: Skin = {
  id: "latch",
  name: "Latch",
  description:
    "Small and tidy: rounded cards, small caps labels and one blue accent.",
  botLook: "solid",
  Frame: LatchFrame,
  home: { Top: LatchHomeTop, Below: LatchHomeBelow },
};
