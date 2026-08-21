import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ConnectorStatus = {
  id: string;
  type: "google_drive" | "onedrive";
  name: string;
  roots: string[];
  configured: boolean;
};

export const connectorKeys = {
  all: ["connectors"] as const,
  list: () => [...connectorKeys.all, "list"] as const,
};

export function connectorListQueryOptions() {
  return queryOptions({
    queryKey: connectorKeys.list(),
    queryFn: async (): Promise<ConnectorStatus[]> => {
      return client("/api/admin/connectors", "connectors", {
        fallback: "Could not load connectors",
      });
    },
  });
}
