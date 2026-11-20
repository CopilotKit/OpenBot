import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  createHostAccessGrant,
  deleteHostAccessGrant,
  getHostAccess,
  stopHostAccess,
} from "@/lib/api/generated/host-access/host-access";
import { idempotencyKey, organizationId } from "@/lib/api/request";

/** Folder access is a person's own: the API answers it for the person asking, as `me`. */
const ME = "me";

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
  /**
   * Whether this OpenBot runs in OpenBot Desktop, the only thing that can open folders on this
   * computer. Absent from a server that predates it, which is read as yes.
   */
  desktop?: boolean;
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
    queryFn: ({ signal }): Promise<HostAccessStatus> =>
      getHostAccess(organizationId(), ME, {
        signal,
        fallback: "Folder access could not be loaded.",
      }),
  });
}

export function requestHostFolderGrantMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    // Answered once the person has chosen a folder in the desktop app, or turned it down.
    mutationFn: (variables: { botId: string }): Promise<unknown> =>
      createHostAccessGrant(
        organizationId(),
        ME,
        { botId: variables.botId },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "The desktop app could not open the folder chooser." },
      ),
    onSuccess: () => invalidateHostAccess(queryClient),
    onError: () => invalidateHostAccess(queryClient),
  });
}

export function revokeHostFolderGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { grantId: string }) => {
      await deleteHostAccessGrant(
        organizationId(),
        ME,
        variables.grantId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Access to that folder could not be revoked." },
      );
    },
    onSuccess: () => invalidateHostAccess(queryClient),
  });
}

export function stopHostAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () => {
      await stopHostAccess(
        organizationId(),
        ME,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Folder access could not be stopped." },
      );
    },
    onSuccess: () => invalidateHostAccess(queryClient),
  });
}
