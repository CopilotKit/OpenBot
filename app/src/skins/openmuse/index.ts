import type { Skin } from "../types";
import { OpenMuseFrame } from "./frame";
import { ActivityScreen } from "./screens/activity";
import { AppsScreen } from "./screens/apps";
import { GoalsScreen } from "./screens/goals";
import { IdeasScreen } from "./screens/ideas";

/**
 * OpenMuse's look: one Bot at the centre of a single phone-shaped column and five tabs in a floating
 * pill. Its identity is the deployment's: the brand.yaml name and each Bot's own OpenBot avatar.
 * Chat is OpenBot's own; Activity, Ideas, Goals and Apps draw OpenBot's approvals,
 * Bot activity, suggestions, routines, responsibilities, connections and memory.
 */
export const openmuse: Skin = {
  id: "openmuse",
  name: "OpenMuse",
  description:
    "One Bot at the centre of a phone-shaped column, with five tabs.",
  Frame: OpenMuseFrame,
  screens: {
    activity: ActivityScreen,
    ideas: IdeasScreen,
    goals: GoalsScreen,
    apps: AppsScreen,
  },
};
