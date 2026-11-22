import { INSTALL_SCENES } from "./install";
import { STATE_SCENES } from "./states";
import type { Scene } from "./types";

export const SCENES: readonly Scene[] = [...INSTALL_SCENES, ...STATE_SCENES];
