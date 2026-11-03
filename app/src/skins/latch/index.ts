import type { Skin } from "../types";

/**
 * Latch's look, taken from Jack's Latch browser: small text, every group on a rounded card with a
 * tiny all-caps label above it, one row style (icon, name, grey line under it, then an arrow or a
 * switch), calm greys and one accent colour. It keeps OpenBot's own frame and screens and only
 * changes how they are drawn, so nothing OpenBot does goes missing.
 */
export const latch: Skin = {
  id: "latch",
  name: "Latch",
  description:
    "Small and tidy: rounded cards, small caps labels and one blue accent.",
  botLook: "solid",
};
