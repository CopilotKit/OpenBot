import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { mcpServers } from "../db/schema";
import type { ComposioBroker } from "./broker";
import { toolkitOf } from "./composio";

/** Fill older app records without changing their connections, schemes, or grants. */
export async function backfillComposioLogos(
  database: Database,
  broker: Pick<ComposioBroker, "listApps">,
) {
  const missing = await database
    .select({ id: mcpServers.id, url: mcpServers.url })
    .from(mcpServers)
    .where(and(eq(mcpServers.provenance, "composio"), isNull(mcpServers.logo)));
  if (missing.length === 0) return;

  const logos = new Map(
    (await broker.listApps()).map((app) => [app.slug, app.logo]),
  );
  for (const row of missing) {
    const slug = toolkitOf(row.url);
    const logo = slug ? logos.get(slug) : null;
    if (!logo) continue;
    await database
      .update(mcpServers)
      .set({ logo })
      .where(
        and(
          eq(mcpServers.id, row.id),
          eq(mcpServers.url, row.url),
          eq(mcpServers.provenance, "composio"),
          isNull(mcpServers.logo),
        ),
      );
  }
}
