import { queryOptions } from "@tanstack/react-query";

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
      const response = await fetch("/api/admin/connectors", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load connectors");
      return ((await response.json()) as { connectors: ConnectorStatus[] })
        .connectors;
    },
  });
}
