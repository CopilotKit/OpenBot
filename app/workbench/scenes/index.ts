// Small starting points. Navigate freely through the real router after opening one.
import type { AppScene } from "../../../desktop/workbench/appContract";
import { DEFAULT_SESSION } from "../session";
const view = (id: string, title: string, route: string): AppScene => ({
  kind: "app",
  id,
  title,
  group: "App",
  start: { route, host: "desktop", session: DEFAULT_SESSION },
});
export const APP_SCENES: readonly AppScene[] = [
  view("app-home", "Home", "/"),
  view("app-settings", "Settings", "/settings"),
  view("app-connections", "Connections", "/connections"),
  view("app-computer", "Computer", "/settings/computer"),
  view("app-bots", "Bots", "/bots"),
  view("app-skills", "Skills", "/skills"),
  {
    ...view("app-home-empty", "Home with no Bots", "/"),
    start: {
      route: "/",
      host: "desktop",
      session: DEFAULT_SESSION,
      agents: [],
      api: {
        "GET /api/v2/organizations/:organizationId/bots": {
          mode: "value",
          body: { bots: [], nextCursor: null },
        },
      },
    },
  },
  {
    ...view("app-signed-out", "Signed out", "/"),
    start: { route: "/", host: "desktop", session: { signedIn: false } },
  },
];
