import type { Skin } from "../types";
import { OpenDuetFrame } from "./frame";
import { TASKS_SCREEN } from "./places";
import { TasksScreen } from "./tasks-screen";

export const openduet: Skin = {
  id: "openduet",
  name: "OpenDuet",
  description:
    "Bots that keep you in the loop, in a column shaped like a phone.",
  Frame: OpenDuetFrame,
  screens: { [TASKS_SCREEN]: TasksScreen },
};
