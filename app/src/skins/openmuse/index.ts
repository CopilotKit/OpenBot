import type { Skin } from "../types";
import { OpenFuseFrame } from "./frame";
import { ActivityScreen } from "./screens/activity";
import { GoalsScreen } from "./screens/goals";
import { IdeasScreen } from "./screens/ideas";

/**
 * OpenFuse's look: one Bot at the centre of a single phone-shaped column and five tabs in a floating
 * pill. Its identity is the deployment's: the brand.yaml name and each Bot's own OpenBot avatar.
 * Chat is OpenBot's own conversation, and Apps is OpenBot's own Connections page. Activity, Ideas
 * and Goals put OpenBot's own sections for the centre Bot under OpenFuse's titles.
 */
export const openmuse: Skin = {
  // The id predates the name OpenFuse. It is what accounts have saved and what `data-skin` keys on,
  // so it stays.
  id: "openmuse",
  name: "OpenFuse",
  description:
    "One Bot at the centre of a phone-shaped column, with five tabs.",
  Frame: OpenFuseFrame,
  screens: {
    activity: ActivityScreen,
    ideas: IdeasScreen,
    goals: GoalsScreen,
  },
};
