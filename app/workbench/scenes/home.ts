import type { AppScene } from "../../../desktop/workbench/appContract";
import { DEFAULT_SESSION } from "../session";

export const HOME_SCENES: readonly AppScene[] = [
  {
    kind: "app",
    id: "app-home-bots",
    title: "Home with Bots",
    group: "App: Home",
    start: { route: "/", host: "desktop", session: DEFAULT_SESSION },
  },
];
