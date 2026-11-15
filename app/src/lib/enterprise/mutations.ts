import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import {
  stopPersonComputers,
  updateCapability,
} from "@/lib/api/generated/capabilities/capabilities";
import {
  deleteNetworkPolicy,
  replaceNetworkPolicy,
} from "@/lib/api/generated/network-policies/network-policies";
import {
  stopInactiveComputers,
  updateOrganizationSettings,
} from "@/lib/api/generated/organization-settings/organization-settings";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { modelKeys } from "@/lib/models/queries";
import {
  type CapabilityKey,
  type EgressRule,
  type EnterpriseSettings,
  enterpriseKeys,
  type NetworkMode,
} from "./queries";

const FALLBACK = "Couldn't save that setting. Try again.";

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
      const { scopeKind, scopeId, capability, allowed } = variables;
      // One level of one switch: the organization's, or one role's or group's by name.
      await updateCapability(
        ORGANIZATION_ID,
        capability,
        scopeKind === "organization"
          ? { organization: allowed }
          : scopeKind === "role"
            ? { roles: { [scopeId]: allowed } }
            : { groups: { [scopeId]: allowed } },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    /*
     * A Bot's profile says whether its computer of its own is in effect, which is decided from its
     * owner's "Isolated Bots" switch, so a switch changing is a change to Bots as well.
     */
    onSuccess: () =>
      Promise.all([
        invalidateEnterprise(queryClient),
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
      ]),
  });
}

export function setEnterpriseSettingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      key: keyof EnterpriseSettings;
      value: unknown;
    }) => {
      await updateOrganizationSettings(
        ORGANIZATION_ID,
        { [variables.key]: variables.value },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    /*
     * The model switch and allowlist change what the composer's picker offers, which the server
     * reads through them, so the picker's catalogue is asked again too.
     */
    onSuccess: () =>
      Promise.all([
        invalidateEnterprise(queryClient),
        queryClient.invalidateQueries({ queryKey: modelKeys.all }),
      ]),
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
      /** The sentence the list was written from, recorded with the save. */
      authoring?: { source: "english"; text: string };
    }) => {
      const { scopeKind, scopeId, ...policy } = variables;
      await replaceNetworkPolicy(
        ORGANIZATION_ID,
        networkPolicyId(scopeKind, scopeId),
        policy,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
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
      try {
        await deleteNetworkPolicy(
          ORGANIZATION_ID,
          networkPolicyId(variables.scopeKind, variables.scopeId),
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        );
      } catch (error) {
        // Already gone, as by another admin a moment ago: what was asked for is so.
        if (
          error instanceof ClientError &&
          error.code === "NETWORK_POLICY_NOT_FOUND"
        )
          return;
        throw error;
      }
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
      /** The computers stopped: `person:<id>`, and `bot:<id>` for each of their Bots' own. */
      stopped: string[];
      failed: { computer: string; reason: string }[];
    }> =>
      stopPersonComputers(
        ORGANIZATION_ID,
        userId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Could not stop that person's computers" },
      ),
  });
}

export function terminateInactiveComputersMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<{ stopped: string[] }> =>
      stopInactiveComputers(
        ORGANIZATION_ID,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Could not sweep inactive computers" },
      ),
  });
}

/** A network policy's address in the API: `organization`, or `group:` and the group's name. */
function networkPolicyId(
  scopeKind: "organization" | "group",
  scopeId: string,
): string {
  return scopeKind === "organization" ? "organization" : `group:${scopeId}`;
}
