export type ConnectorUpsert = {
  kind: "upsert";
  sourceId: string;
  title: string;
  canonicalUrl: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunks: { position: number; content: string; embedding: number[] }[];
  acls: { principal: string; effect: "allow" | "deny" }[];
};

export type ConnectorDelete = {
  kind: "delete";
  sourceId: string;
};

export type ConnectorChange = ConnectorUpsert | ConnectorDelete;

export type ConnectorAdapter = {
  discover: (input: {
    cursor: string | null;
    mode: "sync" | "reconcile";
  }) => Promise<{
    changes: ConnectorChange[];
    nextCursor: string | null;
  }>;
};
