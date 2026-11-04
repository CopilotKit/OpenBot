import type { Database } from "../db/client";
import { type BrokerProvider, toolkitOfFor } from "./access";
import type { ComposioBroker } from "./broker";
import { allServers, updateServer } from "./plugin-store/records";

/**
 * Fill older app records without changing their connections, schemes, or grants.
 *
 * The apps are Intelligence's; each fill is conditional on the app still being the one read (same
 * url, same broker, still no logo), checked against the version the write carries.
 */
export async function backfillBrokeredLogos(
  _database: Database,
  provider: BrokerProvider,
  broker: Pick<ComposioBroker, "listApps">,
) {
  const missing = allServers().filter(
    (row) => row.provenance === provider && row.logo === null,
  );
  if (missing.length === 0) return;

  const logos = new Map(
    (await broker.listApps()).map((app) => [app.slug, app.logo]),
  );
  for (const row of missing) {
    const slug = toolkitOfFor(provider, row.url);
    const logo = slug ? logos.get(slug) : null;
    if (!logo) continue;
    await updateServer(
      row.id,
      { logo },
      (current) =>
        current.url === row.url &&
        current.provenance === provider &&
        current.logo === null,
    );
  }
}
