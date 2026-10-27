import type { ComponentType, ReactNode } from "react";

/**
 * Every skin OpenBot ships. `openbot` is the default and is OpenBot exactly as it is without a
 * skin: no frame of its own, no tokens of its own.
 */
export const SKIN_IDS = [
  "openbot",
  "openduet",
  "opendots",
  "openmuse",
] as const;

export type SkinId = (typeof SKIN_IDS)[number];

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
