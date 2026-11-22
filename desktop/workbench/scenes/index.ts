import { INSTALL_SCENES } from "./install";
import { STATE_SCENES } from "./states";
import type { Scene } from "./types";
import { WINDOW_SCENES } from "./windows";

export const SCENES: readonly Scene[] = [
  ...INSTALL_SCENES,
  ...WINDOW_SCENES,
  ...STATE_SCENES,
];
