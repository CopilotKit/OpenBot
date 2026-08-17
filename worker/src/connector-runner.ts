import type {
  ConnectorAdapter,
  ConnectorChange,
} from "../../server/src/connectors/contract";

export type ConnectorPersistence = {
  cursor: () => Promise<string | null>;
  apply?: (change: ConnectorChange) => Promise<void>;
  commitCursor?: (cursor: string) => Promise<void>;
  persistBatch?: (
    changes: ConnectorChange[],
    cursor: string | null,
  ) => Promise<void>;
  recordRun?: (status: "succeeded" | "failed") => Promise<void>;
};

export async function runConnector(
  adapter: ConnectorAdapter,
  persistence: ConnectorPersistence,
  mode: "sync" | "reconcile" = "sync",
) {
  try {
    const discovered = await adapter.discover({
      cursor: await persistence.cursor(),
      mode,
    });
    if (persistence.persistBatch) {
      await persistence.persistBatch(discovered.changes, discovered.nextCursor);
    } else {
      if (!persistence.apply || !persistence.commitCursor) {
        throw new Error(
          "Connector persistence must support batch or individual writes.",
        );
      }
      for (const change of discovered.changes) await persistence.apply(change);
      if (discovered.nextCursor !== null) {
        await persistence.commitCursor(discovered.nextCursor);
      }
    }
    await persistence.recordRun?.("succeeded");
  } catch (error) {
    await persistence.recordRun?.("failed");
    throw error;
  }
}
