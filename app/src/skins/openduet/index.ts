import type { Skin } from "../types";
import { OpenDuetFrame } from "./frame";
import { TASKS_SCREEN } from "./places";
import { TasksScreen } from "./tasks-screen";

export const openduet: Skin = {
  id: "openduet",
  name: "OpenDuet",
  description:
    "A proactive agent that keeps you in the loop, shaped like a phone.",
  Frame: OpenDuetFrame,
  screens: { [TASKS_SCREEN]: TasksScreen },
};
