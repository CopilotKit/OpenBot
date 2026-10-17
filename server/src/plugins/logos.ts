import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { mcpServers } from "../db/schema";
import { type BrokerProvider, toolkitOfFor } from "./access";
import type { ComposioBroker } from "./broker";

/** Fill older app records without changing their connections, schemes, or grants. */
export async function backfillBrokeredLogos(
  database: Database,
  provider: BrokerProvider,
  broker: Pick<ComposioBroker, "listApps">,
) {
  const missing = await database
    .select({ id: mcpServers.id, url: mcpServers.url })
    .from(mcpServers)
    .where(and(eq(mcpServers.provenance, provider), isNull(mcpServers.logo)));
  if (missing.length === 0) return;

  const logos = new Map(
    (await broker.listApps()).map((app) => [app.slug, app.logo]),
  );
  for (const row of missing) {
    const slug = toolkitOfFor(provider, row.url);
    const logo = slug ? logos.get(slug) : null;
    if (!logo) continue;
    await database
      .update(mcpServers)
      .set({ logo })
      .where(
        and(
          eq(mcpServers.id, row.id),
          eq(mcpServers.url, row.url),
          eq(mcpServers.provenance, provider),
          isNull(mcpServers.logo),
        ),
      );
  }
}
