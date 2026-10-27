import type { Skin } from "../types";
import { OpenMuseFrame } from "./frame";
import { ActivityScreen } from "./screens/activity";
import { AppsScreen } from "./screens/apps";
import { GoalsScreen } from "./screens/goals";
import { IdeasScreen } from "./screens/ideas";

/**
 * OpenMuse: one agent at the centre of a single phone-shaped column, five tabs in a floating pill,
 * and a capybara. Chat is OpenBot's own; Activity, Ideas, Goals and Apps draw OpenBot's approvals,
 * Bot activity, suggestions, routines, responsibilities, connections and memory.
 */
export const openmuse: Skin = {
  id: "openmuse",
  name: "OpenMuse",
  description: "A personal agent whose work keeps going, shaped like a phone.",
  Frame: OpenMuseFrame,
  screens: {
    activity: ActivityScreen,
    ideas: IdeasScreen,
    goals: GoalsScreen,
    apps: AppsScreen,
  },
};
