import type { Skin } from "../types";
import { OpenDuetFrame } from "./frame";

export const openduet: Skin = {
  id: "openduet",
  name: "OpenDuet",
  description:
    "Bots that keep you in the loop, in a column shaped like a phone.",
  // Its Tasks tab is OpenBot's own Tasks, so it needs no screen of its own.
  Frame: OpenDuetFrame,
};
