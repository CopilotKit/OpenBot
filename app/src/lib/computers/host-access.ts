import {
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type HostFolderGrant = {
  id: string;
  botId: string;
  actorId: string;
  displayName: string;
  revoked?: boolean;
  ownerName?: string;
  ownerEmail?: string;
};

export type HostAccessPendingOperation = {
  operationId: string;
  kind?:
    | "choose_folder"
    | "list_files"
    | "read_file"
    | "write_file"
    | "run_command"
    | "cancel"
    | "stop";
  botId: string;
  actorId?: string;
  displayName?: string;
  writable?: boolean;
  ownerName?: string;
  ownerEmail?: string;
  status?: "pending" | "approved" | "refused";
};

export type HostAccessStatus = {
  connected: boolean;
  grants: HostFolderGrant[];
  pending: HostAccessPendingOperation[];
};

export const hostAccessKeys = {
  all: ["host-access"] as const,
  status: () => ["host-access", "status"] as const,
};

function invalidateHostAccess(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: hostAccessKeys.all });
}

export function hostAccessQueryOptions() {
  return queryOptions({
    queryKey: hostAccessKeys.status(),
    refetchInterval: 2_000,
    queryFn: (): Promise<HostAccessStatus> =>
      client("/api/host-access", {
        fallback: "Folder access could not be loaded.",
      }).then((response) => response.json()),
  });
}

export function requestHostFolderGrantMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: { botId: string }): Promise<unknown> =>
      client("/api/host-access/grants", {
        method: "POST",
        body: { botId: variables.botId },
        fallback: "The desktop app could not open the folder chooser.",
      }).then((response) => response.json()),
    onSuccess: () => invalidateHostAccess(queryClient),
    onError: () => invalidateHostAccess(queryClient),
  });
}

export function revokeHostFolderGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { grantId: string }) => {
      await client(
        `/api/host-access/grants/${encodeURIComponent(variables.grantId)}`,
        {
          method: "DELETE",
          fallback: "The host folder grant could not be revoked.",
        },
      );
    },
    onSuccess: () => invalidateHostAccess(queryClient),
  });
}

export function stopHostAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () => {
      await client("/api/host-access/stop", {
        method: "POST",
        fallback: "Host folder access could not be stopped.",
      });
    },
    onSuccess: () => invalidateHostAccess(queryClient),
  });
}
