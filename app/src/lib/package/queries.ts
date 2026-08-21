import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const packageKeys = { active: ["tenant-package", "active"] as const };

export function activePackageQueryOptions() {
  return queryOptions({
    queryKey: packageKeys.active,
    queryFn: async () => {
      const response = await client("/api/admin/package", {
        fallback: "Could not load the active package",
      });
      return response.json();
    },
  });
}
