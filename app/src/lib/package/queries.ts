import { queryOptions } from "@tanstack/react-query";

export const packageKeys = { active: ["tenant-package", "active"] as const };

export function activePackageQueryOptions() {
  return queryOptions({
    queryKey: packageKeys.active,
    queryFn: async () => {
      const response = await fetch("/api/admin/package", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load the active package");
      return response.json();
    },
  });
}
