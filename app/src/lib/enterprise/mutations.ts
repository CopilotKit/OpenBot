import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type CapabilityKey,
  type EgressRule,
  type EnterpriseSettings,
  enterpriseKeys,
  type NetworkMode,
} from "./queries";

const FALLBACK = "Could not save that enterprise control";

function invalidateEnterprise(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: enterpriseKeys.all });
}

/** `allowed: null` removes the switch at that scope, so it inherits again. */
export function setCapabilityMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      scopeKind: "organization" | "role" | "group";
      scopeId: string;
      capability: CapabilityKey;
      allowed: boolean | null;
    }) => {
      await client("/api/admin/enterprise/capabilities", {
        method: "PUT",
        body: variables,
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateEnterprise(queryClient),
  });
}

export function setEnterpriseSettingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      key: keyof EnterpriseSettings;
      value: unknown;
    }) => {
      await client(`/api/admin/enterprise/settings/${variables.key}`, {
        method: "PUT",
        body: { value: variables.value },
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateEnterprise(queryClient),
  });
}

export function setNetworkPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      scopeKind: "organization" | "group";
      scopeId: string;
      mode: NetworkMode;
      rules: EgressRule[];
      locked: boolean;
    }) => {
      await client("/api/admin/enterprise/network", {
        method: "PUT",
        body: variables,
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateEnterprise(queryClient),
  });
}

export function removeNetworkPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      scopeKind: "organization" | "group";
      scopeId: string;
    }) => {
      const query =
        variables.scopeKind === "group"
          ? `?group=${encodeURIComponent(variables.scopeId)}`
          : "";
      await client(
        `/api/admin/enterprise/network/${variables.scopeKind}${query}`,
        {
          method: "DELETE",
          fallback: FALLBACK,
        },
      );
    },
    onSuccess: () => invalidateEnterprise(queryClient),
  });
}

/** Stop a member's Bots' computers. Disks are kept; each Bot starts fresh next session. */
export function terminateMemberComputersMutationOptions() {
  return mutationOptions({
    mutationFn: async (
      userId: string,
    ): Promise<{
      stopped: string[];
      failed: { botId: string; reason: string }[];
    }> =>
      (
        await client(
          `/api/admin/enterprise/people/${userId}/terminate-computers`,
          {
            method: "POST",
            fallback: "Could not stop that person's computers",
          },
        )
      ).json(),
  });
}

export function terminateInactiveComputersMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<{ stopped: string[] }> =>
      (
        await client("/api/admin/enterprise/computers/terminate-inactive", {
          method: "POST",
          fallback: "Could not sweep inactive computers",
        })
      ).json(),
  });
}
