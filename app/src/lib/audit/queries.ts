import { queryOptions } from "@tanstack/react-query";

export const auditKeys = { all: ["audit-events"] as const };

export function auditEventsQueryOptions(search = "") {
  return queryOptions({
    queryKey: [...auditKeys.all, search] as const,
    queryFn: async () => {
      const response = await fetch(`/api/admin/audit-events${search}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load audit events");
      return response.json();
    },
  });
}
