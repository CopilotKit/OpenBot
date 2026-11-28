import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import {
  stopPersonComputers,
  updateCapability,
} from "@/lib/api/generated/capabilities/capabilities";
import type { CapabilityChangeScopeKind } from "@/lib/api/generated/model";
import {
  deleteNetworkPolicy,
  replaceNetworkPolicy,
} from "@/lib/api/generated/network-policies/network-policies";
import {
  stopInactiveComputers,
  updateAppsSetting,
  updateOrganizationSettings,
} from "@/lib/api/generated/organization-settings/organization-settings";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { modelKeys } from "@/lib/models/queries";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import {
  type CapabilityKey,
  type EgressRule,
  type EnterpriseSettings,
  enterpriseKeys,
  type NetworkMode,
  type NetworkScopeKind,
} from "./queries";

const FALLBACK = "Couldn't save that setting. Try again.";

function invalidateEnterprise(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: enterpriseKeys.all });
}

/** `allowed: null` removes the switch at that scope, so it inherits again. */
export function setCapabilityMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      scopeKind: CapabilityChangeScopeKind;
      scopeId: string;
      capability: CapabilityKey;
      allowed: boolean | null;
    }) => {
      const { scopeKind, scopeId, capability, allowed } = variables;
      // One level of one switch: the organization's, one role's by name, one team's by id, or one
      // directory group's by name.
      await updateCapability(
        organizationId(),
        capability,
        scopeKind === "organization"
          ? { organization: allowed }
          : scopeKind === "role"
            ? { roles: { [scopeId]: allowed } }
            : scopeKind === "team"
              ? { teams: { [scopeId]: allowed } }
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
        organizationId(),
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

/**
 * Open the organization's apps, or lock them down (`lockedDown`, at the apps setting's own address).
 * Either changes what giving an app does from then on. Locking down takes nothing back unless
 * `takeBackWhatOpenGave` asks it to: what OpenBot gave Bots by itself while open goes, and what
 * anybody gave by hand stays. Opening never sends it.
 */
export function setAppsLockedDownMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      variables:
        | { lockedDown: true; takeBackWhatOpenGave: boolean }
        | { lockedDown: false },
    ) => {
      await updateAppsSetting(
        organizationId(),
        variables,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't change how apps are given. Try again." },
      );
    },
    /*
     * What every Bot may use moves with it: each app's page and Bots, and a Bot's own app list, are
     * asked again beside the settings.
     */
    onSuccess: () =>
      Promise.all([
        invalidateEnterprise(queryClient),
        invalidatePlugins(queryClient),
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
      ]),
  });
}

export function setNetworkPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      scopeKind: NetworkScopeKind;
      scopeId: string;
      mode: NetworkMode;
      rules: EgressRule[];
      locked: boolean;
      /** The sentence the list was written from, recorded with the save. */
      authoring?: { source: "english"; text: string };
    }) => {
      const { scopeKind, scopeId, ...policy } = variables;
      await replaceNetworkPolicy(
        organizationId(),
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
      scopeKind: NetworkScopeKind;
      scopeId: string;
    }) => {
      try {
        await deleteNetworkPolicy(
          organizationId(),
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
        organizationId(),
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
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Could not sweep inactive computers" },
      ),
  });
}

/**
 * A network policy's address in the API: `organization`, `team:` and the team's id, or `group:` and
 * the directory group's name.
 */
function networkPolicyId(scopeKind: NetworkScopeKind, scopeId: string): string {
  return scopeKind === "organization"
    ? "organization"
    : `${scopeKind}:${scopeId}`;
}
