import type { SkinId } from "@openbot/shared/user-preferences";
import type { ComponentType, ReactNode } from "react";

/*
 * The ids live in `shared/` because the choice is saved on the person's account and the server
 * checks it. They are re-exported here so a skin reads them from beside its own type.
 */
export {
  DEFAULT_SKIN,
  SKIN_IDS,
  type SkinId,
} from "@openbot/shared/user-preferences";

export type Skin = {
  id: SkinId;
  /** The product name this skin presents as, shown in the picker and inside its own frame. */
  name: string;
  /** One line for the picker. */
  description: string;
  /**
   * Replaces OpenBot's sidebar frame around every page under `/_authed/_app`. It must render
   * `children` (the page) and must give the person a way to reach Settings, so a skin can always
   * be switched back. Absent, the page keeps OpenBot's own frame.
   */
  Frame?: ComponentType<{ children: ReactNode }>;
  /**
   * Screens only this skin has, served at `/s/<key>`. They draw OpenBot's existing data; a skin
   * adds no endpoint. A key the active skin does not have goes home.
   */
  screens?: Record<string, ComponentType>;
};
