/**
 * The reads Connections and an app's screen share: the person's apps and where each stands (./connect-app.ts), how
 * apps are set up here, and whether this OpenBot lets the phone connect one. The same reads the web app's Connections
 * makes: the apps added here, OpenBot's catalogue, how apps are set up, and the person's connections.
 */
import { everyPage, ME, ORGANIZATION_ID, readDeployment } from "./api";
import {
  getAppSetup,
  listAppDirectory,
  listApps,
} from "./api/generated/apps/apps";
import { listConnections } from "./api/generated/connections/connections";
import type { AppSetup, Connection } from "./api/generated/model";
import { phoneConnects, type YourApp, yourApps } from "./connect-app";

/** Every connection the person holds, page by page. */
export function everyConnection(): Promise<Connection[]> {
  return everyPage(
    (page) => listConnections(ORGANIZATION_ID, ME, page),
    (page) => page.connections,
  );
}

export type YourConnections = {
  apps: YourApp[];
  setup: AppSetup;
  /** Whether the phone may connect an app here (`mobileConnections`). */
  phoneConnects: boolean;
};

/**
 * Everything Connections shows. The four reads the list comes from fail together, as on the web app: apps without the
 * person's connections would say Connect over accounts they already have.
 */
export async function loadYourConnections(): Promise<YourConnections> {
  const [apps, catalogue, setup, connections, deployment] = await Promise.all([
    everyPage(
      (page) => listApps(ORGANIZATION_ID, page),
      (page) => page.apps,
    ),
    everyPage(
      (page) =>
        listAppDirectory(ORGANIZATION_ID, { source: "catalogue", ...page }),
      (page) => page.entries,
    ),
    getAppSetup(ORGANIZATION_ID),
    everyConnection(),
    // A deployment that can't be read offers nothing new: the list still shows.
    readDeployment(true).catch(() => undefined),
  ]);
  return {
    apps: yourApps({ apps, catalogue, setup, connections }),
    setup,
    phoneConnects: phoneConnects(deployment),
  };
}
